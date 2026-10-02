// Cœur de la réservation par créneaux MYU (partagé par /api/booking,
// /api/public-booking, /api/create-checkout, /api/sumup-webhook, /api/admin-myu).
// Fichier préfixé "_" : Vercel ne l'expose pas comme route.
//
// Principes :
//  - Fuseau unique America/Martinique pour tout ce qui est affiché ou saisi.
//  - Un créneau proposé = plage [début, début + durée de la prestation[ qui
//    respecte les horaires d'Astrid, ne chevauche aucune plage bloquée de
//    l'application et aucun événement "occupé" de son agenda Google principal.
//  - Avant tout paiement : le créneau est re-vérifié côté serveur puis
//    "maintenu" (bloque = true) pour une durée limitée. La base refuse tout
//    chevauchement (contrainte d'exclusion) : deux clientes ne peuvent pas
//    payer pour le même créneau.
//  - Le paiement n'est JAMAIS déduit du navigateur : seul l'état relu chez
//    SumUp avec notre clé confirme (myu_confirmer_paiement) ou libère
//    (myu_liberer_maintien) un créneau.
//  - Après confirmation : synchronisation agenda Google + feuille "Demandes
//    (secours)" via l'Apps Script existant. En cas d'échec, le créneau reste
//    bloqué dans l'application, l'erreur est enregistrée et la synchro est
//    retentée automatiquement.

const TZ = "America/Martinique";
const SITE_ORIGIN = process.env.MYU_SITE_ORIGIN || "https://missu-two.vercel.app";
const APPS_SCRIPT_URL =
  process.env.MYU_APPS_SCRIPT_URL ||
  "https://script.google.com/macros/s/AKfycbzFqK24wzlD6zjHOn6SdmtZINVsoAVbuD8ZKK5AYqkhzR1dg8d4mWJsNACb8WuS-JkjZg/exec";
const SUMUP_API = process.env.MYU_SUMUP_API || "https://api.sumup.com";

const DEFAULT_SETTINGS = {
  lieux: ["Ducos"],
  horaires: {
    1: [["09:00", "17:00"]], 2: [["09:00", "17:00"]], 3: [["09:00", "17:00"]],
    4: [["09:00", "17:00"]], 5: [["09:00", "17:00"]], 6: [["09:00", "13:00"]],
  },
  pas_minutes: 30,
  delai_min_minutes: 120,
  horizon_jours: 60,
  maintien_minutes: 20,
  agenda_mots_ignores: ["Collège Édouard Glissant"],
};

const SERVICE_LABELS = {
  candy_lips: "Candy Lips", powder_brows: "Powder Brows", velvet_lips: "Velvet Lips",
  aqualips_blush: "AquaLips Blush", neutralisation: "Neutralisation lèvres foncées",
  eyeliner_classique: "Eyeliner classique", eyeliner_poudre: "Eyeliner poudré",
  modele_myu: "Offre modèle MYU", taches_brunes_visage: "Correction taches brunes · visage",
  taches_brunes_corps: "Correction taches brunes · corps", vergetures: "Correction vergetures",
  conseil: "Conseil personnalisé", microneedling: "Microneedling", bb_glow: "BB Glow",
  soins_corps_infrarouge: "Soins corps infrarouge",
};

const STATUT_LABELS = {
  demande: "Demande reçue",
  en_attente_paiement: "En attente du paiement",
  confirme: "Confirmé",
  modifie: "Modifié",
  annule: "Annulé — créneau libéré",
  terminee: "Terminé",
};
const PAYMENT_LABELS = {
  non_requis: "Aucun acompte en ligne",
  en_attente: "Acompte en attente",
  paye: "Acompte payé",
  echoue: "Paiement non abouti",
  rembourse: "Acompte remboursé",
};

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function serviceLabel(key) {
  return SERVICE_LABELS[key] || String(key || "").replace(/_/g, " ");
}

// ------------------------------------------------------------------
// Dates et heures (America/Martinique)
// ------------------------------------------------------------------
const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
});

function zoned(date) {
  const p = Object.fromEntries(partsFmt.formatToParts(date).map((x) => [x.type, x.value]));
  const dows = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
    isoDow: dows[p.weekday],
    utcGuess: Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second),
  };
}

function offsetMinutes(date) {
  return Math.round((zoned(date).utcGuess - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

// "2026-10-05" + "10:34" (heure de Martinique) -> Date (instant UTC)
function localToDate(dateStr, timeStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off = offsetMinutes(new Date(guess));
  const result = new Date(guess - off * 60000);
  const back = zoned(result);
  if (back.date !== dateStr || back.time !== `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`) {
    throw httpError(400, "Heure invalide.");
  }
  return result;
}

function addDaysStr(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

function isoDowOf(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return js === 0 ? 7 : js;
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
}

function fromMinutes(n) {
  return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
}

const longDateFmt = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric" });

function todayLocal(now = new Date()) {
  return zoned(now).date;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// ------------------------------------------------------------------
// Réglages et prestations
// ------------------------------------------------------------------
async function loadSettings(admin) {
  const { data, error } = await admin.from("myu_reglages_reservation").select("*").eq("id", 1).maybeSingle();
  if (error) throw error;
  const s = { ...DEFAULT_SETTINGS, ...(data || {}) };
  s.lieux = (s.lieux && s.lieux.length ? s.lieux : DEFAULT_SETTINGS.lieux).filter(Boolean);
  s.agenda_mots_ignores = (s.agenda_mots_ignores || []).filter(Boolean);
  return s;
}

async function loadPrestation(admin, typePrestation) {
  const { data, error } = await admin.from("prestations_reservation").select("*").eq("type_prestation", typePrestation).maybeSingle();
  if (error) throw error;
  if (!data || !data.active) throw httpError(400, "Cette prestation n'est pas disponible à la réservation en ligne.");
  return { ...data, duree_minutes: Number(data.duree_minutes) || 180, deposit_amount: Number(data.deposit_amount) || 0 };
}

// ------------------------------------------------------------------
// Agenda Google d'Astrid (via l'Apps Script du Sheet, qui s'exécute avec son compte)
// ------------------------------------------------------------------
async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal, redirect: "follow" });
  } finally {
    clearTimeout(t);
  }
}

async function fetchCalendarBusy(from, to, ignore) {
  const qs = new URLSearchParams({
    action: "busy", from: from.toISOString(), to: to.toISOString(), ignore: (ignore || []).join("|"),
  });
  let res;
  try {
    res = await fetchWithTimeout(`${APPS_SCRIPT_URL}?${qs}`, {}, 15000);
  } catch (e) {
    throw httpError(503, "Agenda injoignable : " + (e.name === "AbortError" ? "délai dépassé" : e.message));
  }
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* réponse non JSON */ }
  if (!res.ok || !body || body.ok !== true || !Array.isArray(body.busy)) {
    throw httpError(503, "Agenda : réponse invalide (" + res.status + ") " + (body?.error || text.slice(0, 80)));
  }
  return body.busy.map((b) => {
    if (b.allDay && b.startDate && b.endDate) {
      return { start: localToDate(b.startDate, "00:00"), end: localToDate(b.endDate, "00:00"), myuRdv: b.myuRdv || null, title: b.title || "" };
    }
    return { start: new Date(b.start), end: new Date(b.end), myuRdv: b.myuRdv || null, title: b.title || "" };
  }).filter((b) => !isNaN(b.start) && !isNaN(b.end) && b.end > b.start);
}

// ------------------------------------------------------------------
// SumUp
// ------------------------------------------------------------------
function sumupKey() {
  const key = process.env.SUMUP_API_KEY;
  if (!key) throw httpError(500, "SUMUP_API_KEY manquante côté serveur.");
  return key;
}

async function sumupGetCheckout(id) {
  const res = await fetchWithTimeout(`${SUMUP_API}/v0.1/checkouts/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${sumupKey()}` },
  }, 12000);
  if (!res.ok) throw httpError(502, `SumUp a répondu ${res.status} pour le checkout.`);
  return res.json();
}

// Désactive un checkout encore ouvert (plus aucun paiement possible dessus).
async function sumupDeactivate(id) {
  try {
    const res = await fetchWithTimeout(`${SUMUP_API}/v0.1/checkouts/${encodeURIComponent(id)}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${sumupKey()}` },
    }, 12000);
    return res.ok;
  } catch {
    return false;
  }
}

function checkoutIsPaid(checkout) {
  if (!checkout) return false;
  if (checkout.status === "PAID") return true;
  return Array.isArray(checkout.transactions) && checkout.transactions.some((t) => t && t.status === "SUCCESSFUL");
}

function checkoutMatches(checkout, rdv) {
  const expectedMerchant = process.env.SUMUP_MERCHANT_CODE;
  return (
    Math.abs(Number(checkout?.amount) - Number(rdv.deposit_amount)) < 0.005 &&
    checkout?.currency === "EUR" &&
    String(checkout?.checkout_reference || "") === String(rdv.id) &&
    (!expectedMerchant || String(checkout?.merchant_code || "") === String(expectedMerchant))
  );
}

// ------------------------------------------------------------------
// Rendez-vous : lecture des plages bloquées, libération des maintiens expirés
// ------------------------------------------------------------------
async function loadBlocked(admin, from, to, excludeId) {
  let q = admin.from("rendez_vous").select("id,debut,fin").eq("bloque", true).lt("debut", to.toISOString()).gt("fin", from.toISOString());
  if (excludeId) q = q.neq("id", excludeId);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map((r) => ({ start: new Date(r.debut), end: new Date(r.fin), id: r.id }));
}

async function getRdv(admin, id) {
  const { data, error } = await admin.from("rendez_vous").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}

async function rpc(admin, fn, args) {
  const { data, error } = await admin.rpc(fn, args);
  if (error) throw error;
  return data;
}

// Rapproche un rendez-vous de l'état réel de son paiement chez SumUp.
// Retourne { etat: 'paye' | 'libere' | 'en_attente' | 'incoherent' | 'sans_paiement', rdv }.
async function reconcilePayment(admin, rdv, { checkout, sync = true } = {}) {
  if (!rdv) return { etat: "introuvable" };
  if (rdv.payment_status === "paye") return { etat: "paye", rdv };
  if (!rdv.payment_reference) return { etat: "sans_paiement", rdv };
  const co = checkout || (await sumupGetCheckout(rdv.payment_reference));
  if (!checkoutMatches(co, rdv)) {
    console.error(`[booking] checkout incohérent pour rdv ${rdv.id}`);
    return { etat: "incoherent", rdv };
  }
  if (checkoutIsPaid(co)) {
    const result = await rpc(admin, "myu_confirmer_paiement", { p_rdv: rdv.id, p_reference: rdv.payment_reference });
    const fresh = await getRdv(admin, rdv.id);
    if (sync && result?.resultat === "confirme") {
      await syncBookingExternal(admin, rdv.id).catch((e) => console.error("[booking] synchro après paiement :", e.message));
    }
    return { etat: "paye", rdv: (await getRdv(admin, rdv.id)) || fresh, alerte: result?.alerte || null };
  }
  if (co?.status === "FAILED" || co?.status === "EXPIRED") {
    await rpc(admin, "myu_liberer_maintien", { p_rdv: rdv.id, p_motif: `Paiement ${co.status === "FAILED" ? "échoué" : "expiré"} (vérifié chez SumUp)` });
    return { etat: "libere", rdv: await getRdv(admin, rdv.id) };
  }
  return { etat: "en_attente", rdv, checkout: co };
}

// Libère un maintien après vérification qu'aucun paiement n'a abouti.
// Si SumUp est injoignable, le créneau reste bloqué (on ne libère jamais "à l'aveugle").
async function releaseHoldSafely(admin, rdv, motif) {
  if (!rdv || rdv.statut !== "en_attente_paiement" || rdv.payment_status === "paye") return { etat: "inchange", rdv };
  if (rdv.payment_reference) {
    const first = await reconcilePayment(admin, rdv);
    if (first.etat !== "en_attente") return first;
    await sumupDeactivate(rdv.payment_reference);
    const second = await reconcilePayment(admin, rdv);
    if (second.etat !== "en_attente") return second;
  }
  const r = await rpc(admin, "myu_liberer_maintien", { p_rdv: rdv.id, p_motif: motif });
  return { etat: r === "libere" ? "libere" : r, rdv: await getRdv(admin, rdv.id) };
}

async function releaseExpiredHolds(admin, { limit = 10 } = {}) {
  const { data, error } = await admin
    .from("rendez_vous").select("*")
    .eq("statut", "en_attente_paiement").eq("bloque", true)
    .lt("maintien_expire_le", new Date().toISOString())
    .limit(limit);
  if (error) throw error;
  const out = { liberes: 0, payes: 0, en_attente: 0, erreurs: 0 };
  for (const rdv of data || []) {
    try {
      const r = await releaseHoldSafely(admin, rdv, "Maintien expiré sans paiement (vérifié chez SumUp)");
      if (r.etat === "libere") out.liberes++;
      else if (r.etat === "paye") out.payes++;
      else out.en_attente++;
    } catch (e) {
      out.erreurs++;
      console.error(`[booking] libération maintien ${rdv.id} :`, e.message);
    }
  }
  return out;
}

// ------------------------------------------------------------------
// Disponibilités
// ------------------------------------------------------------------
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

async function computeSlots(admin, { typePrestation, lieu, from, days, excludeRdvId, now = new Date(), settings, prestation }) {
  settings = settings || (await loadSettings(admin));
  prestation = prestation || (await loadPrestation(admin, typePrestation));
  if (!settings.lieux.includes(lieu)) throw httpError(400, "Lieu non proposé.");
  const today = todayLocal(now);
  let start = from && DATE_RE.test(from) && from > today ? from : today;
  const horizonEnd = addDaysStr(today, settings.horizon_jours);
  const nDays = Math.min(Math.max(Number(days) || 14, 1), 31);
  const dates = [];
  for (let i = 0; i < nDays; i++) {
    const d = addDaysStr(start, i);
    if (d > horizonEnd) break;
    dates.push(d);
  }
  if (!dates.length) return { dureeMinutes: prestation.duree_minutes, jours: [] };

  const rangeStart = localToDate(dates[0], "00:00");
  const rangeEnd = localToDate(addDaysStr(dates[dates.length - 1], 1), "00:00");
  const [blocked, busy] = await Promise.all([
    loadBlocked(admin, rangeStart, rangeEnd, excludeRdvId),
    fetchCalendarBusy(rangeStart, rangeEnd, settings.agenda_mots_ignores),
  ]);
  const busyAll = [...blocked, ...busy.filter((b) => !excludeRdvId || b.myuRdv !== excludeRdvId)];
  const earliest = new Date(now.getTime() + settings.delai_min_minutes * 60000);
  const dur = prestation.duree_minutes;
  const step = settings.pas_minutes;

  const jours = dates.map((date) => {
    const windows = settings.horaires[String(isoDowOf(date))] || settings.horaires[isoDowOf(date)] || [];
    const creneaux = [];
    for (const [a, b] of windows) {
      for (let m = toMinutes(a); m + dur <= toMinutes(b); m += step) {
        const s = localToDate(date, fromMinutes(m));
        const e = new Date(s.getTime() + dur * 60000);
        if (s < earliest) continue;
        if (busyAll.some((x) => overlaps(s, e, x.start, x.end))) continue;
        creneaux.push(fromMinutes(m));
      }
    }
    return { date, libelle: longDateFmt.format(localToDate(date, "12:00")), creneaux };
  });
  return { dureeMinutes: dur, jours };
}

async function remainingLimitedPlaces(admin, prestation) {
  if (!prestation.is_limited_offer) return null;
  const { data, error } = await admin.from("rendez_vous").select("id")
    .eq("type_prestation", prestation.type_prestation).eq("statut", "en_attente_paiement").eq("bloque", true);
  if (error) throw error;
  return (Number(prestation.available_slots) || 0) - (data || []).length;
}

// ------------------------------------------------------------------
// Création d'un créneau maintenu (avant paiement) ou confirmé (sans acompte)
// ------------------------------------------------------------------
function validateBookingInput({ typePrestation, lieu, dateRdv, heureRdv }) {
  if (!typePrestation) throw httpError(400, "Choisissez une prestation.");
  if (!lieu) throw httpError(400, "Choisissez un lieu.");
  if (!dateRdv || !DATE_RE.test(dateRdv)) throw httpError(400, "Choisissez un jour.");
  if (!heureRdv || !TIME_RE.test(heureRdv)) throw httpError(400, "Choisissez un horaire précis.");
}

async function assertSlotBookable(admin, input, opts = {}) {
  validateBookingInput(input);
  const settings = await loadSettings(admin);
  const prestation = await loadPrestation(admin, input.typePrestation);
  if (!settings.lieux.includes(input.lieu)) throw httpError(400, "Ce lieu n'est pas proposé.");
  await releaseExpiredHolds(admin, { limit: 5 }).catch((e) => console.error("[booking] maintiens expirés :", e.message));
  const places = await remainingLimitedPlaces(admin, prestation);
  if (places !== null && places <= 0) throw httpError(409, "Cette offre est complète pour le moment.");
  const slots = await computeSlots(admin, {
    typePrestation: input.typePrestation, lieu: input.lieu, from: input.dateRdv, days: 1, settings, prestation, now: opts.now,
  });
  const day = slots.jours.find((j) => j.date === input.dateRdv);
  if (!day || !day.creneaux.includes(input.heureRdv)) {
    throw httpError(409, "Ce créneau n'est plus disponible. Merci d'en choisir un autre.");
  }
  return { settings, prestation };
}

async function createHold(admin, { clientId, input, contactEmail, settings, prestation }) {
  const debut = localToDate(input.dateRdv, input.heureRdv);
  const fin = new Date(debut.getTime() + prestation.duree_minutes * 60000);
  const needsPayment = prestation.deposit_amount > 0;
  const row = {
    client_id: clientId,
    type_prestation: input.typePrestation,
    lieu: input.lieu,
    date_rdv: input.dateRdv,
    heure_rdv: input.heureRdv,
    debut: debut.toISOString(),
    fin: fin.toISOString(),
    duree_minutes: prestation.duree_minutes,
    bloque: true,
    deposit_amount: prestation.deposit_amount,
    contact_email: contactEmail || null,
    statut: needsPayment ? "en_attente_paiement" : "confirme",
    payment_status: needsPayment ? "en_attente" : "non_requis",
    maintien_expire_le: needsPayment ? new Date(Date.now() + settings.maintien_minutes * 60000).toISOString() : null,
    confirme_le: needsPayment ? null : new Date().toISOString(),
    agenda_statut: needsPayment ? "non_requis" : "a_synchroniser",
    feuille_statut: needsPayment ? "non_requis" : "a_synchroniser",
  };
  const { data, error } = await admin.from("rendez_vous").insert(row).select().single();
  if (error) {
    if (error.code === "23P01" || error.code === "23505") {
      throw httpError(409, "Ce créneau vient d'être réservé par une autre personne. Merci d'en choisir un autre.");
    }
    throw error;
  }
  return data;
}

async function startPayment(admin, rdv, { redirectUrl }) {
  const merchant = process.env.SUMUP_MERCHANT_CODE;
  if (!merchant) throw httpError(500, "Paiement en ligne non configuré.");
  let checkout;
  try {
    const res = await fetchWithTimeout(`${SUMUP_API}/v0.1/checkouts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${sumupKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        checkout_reference: rdv.id,
        amount: Number(rdv.deposit_amount),
        currency: "EUR",
        merchant_code: merchant,
        description: `Acompte MYU — ${serviceLabel(rdv.type_prestation)} — ${rdv.date_rdv} ${String(rdv.heure_rdv).slice(0, 5)} (${rdv.lieu})`,
        valid_until: rdv.maintien_expire_le,
        redirect_url: redirectUrl,
        return_url: `${SITE_ORIGIN}/api/sumup-webhook`,
        hosted_checkout: { enabled: true },
      }),
    }, 15000);
    checkout = await res.json().catch(() => null);
    if (!res.ok || !checkout?.id) throw new Error(checkout?.message || `SumUp a répondu ${res.status}`);
  } catch (e) {
    console.error("[booking] création checkout SumUp :", e.message);
    await rpc(admin, "myu_liberer_maintien", { p_rdv: rdv.id, p_motif: "Paiement non initié (SumUp indisponible)" }).catch(() => {});
    throw httpError(502, "Le paiement n'a pas pu être initié. Le créneau a été libéré, merci de réessayer.");
  }
  const { error } = await admin.from("rendez_vous").update({ payment_reference: checkout.id }).eq("id", rdv.id);
  if (error) {
    await sumupDeactivate(checkout.id);
    await rpc(admin, "myu_liberer_maintien", { p_rdv: rdv.id, p_motif: "Paiement non initié (enregistrement impossible)" }).catch(() => {});
    throw httpError(500, "Le paiement n'a pas pu être initié. Merci de réessayer.");
  }
  return checkout.hosted_checkout_url || null;
}

// ------------------------------------------------------------------
// Vue unique d'un rendez-vous (confirmation, espace cliente, admin, feuille)
// ------------------------------------------------------------------
function bookingView(rdv, { profile, scope } = {}) {
  if (!rdv) return null;
  const debut = rdv.debut ? new Date(rdv.debut) : null;
  const fin = rdv.fin ? new Date(rdv.fin) : null;
  const deposit = Number(rdv.deposit_amount) || 0;
  const paymentLabel = rdv.payment_status === "paye" && deposit
    ? `Acompte payé (${deposit.toFixed(0)} €)`
    : (PAYMENT_LABELS[rdv.payment_status] || rdv.payment_status) + (deposit && rdv.payment_status !== "non_requis" ? ` (${deposit.toFixed(0)} €)` : "");
  const view = {
    id: rdv.id,
    dossierId: rdv.dossier_id || null,
    typePrestation: rdv.type_prestation,
    prestation: serviceLabel(rdv.type_prestation || rdv.prestation),
    lieu: rdv.lieu || null,
    date: debut ? zoned(debut).date : rdv.date_rdv || null,
    dateLongue: debut ? longDateFmt.format(debut) : null,
    heureDebut: debut ? zoned(debut).time : (rdv.heure_rdv ? String(rdv.heure_rdv).slice(0, 5) : null),
    heureFin: fin ? zoned(fin).time : null,
    dureeMinutes: rdv.duree_minutes || null,
    statut: rdv.statut,
    statutLibelle: STATUT_LABELS[rdv.statut] || rdv.statut,
    paiement: { statut: rdv.payment_status, libelle: paymentLabel, montant: deposit },
    creneauBloque: !!rdv.bloque,
    maintienExpireLe: rdv.maintien_expire_le || null,
    prenom: profile?.first_name || null,
  };
  if (scope === "sync" || scope === "admin") {
    view.nom = profile?.last_name || "";
    view.telephone = profile?.phone || "";
    view.email = rdv.contact_email || "";
    view.debutIso = rdv.debut;
    view.finIso = rdv.fin;
    view.agenda = { statut: rdv.agenda_statut, erreur: rdv.agenda_erreur, evenementId: rdv.agenda_evenement_id, tentatives: rdv.agenda_tentatives, derniereTentative: rdv.agenda_derniere_tentative };
    view.feuille = { statut: rdv.feuille_statut, erreur: rdv.feuille_erreur };
    view.alerte = rdv.alerte || null;
    // Ce que l'agenda doit refléter : un créneau bloqué et confirmé y figure ;
    // un rendez-vous annulé/libéré qui y figurait doit en être retiré.
    view.agendaAction = rdv.bloque && rdv.statut !== "en_attente_paiement"
      ? "upsert"
      : (rdv.agenda_evenement_id && !rdv.bloque ? "remove" : "none");
    view.feuilleAction = ["confirme", "modifie", "terminee", "annule"].includes(rdv.statut) && (rdv.payment_status === "paye" || rdv.confirme_le) ? "upsert" : "none";
  }
  return view;
}

async function loadProfile(admin, clientId) {
  if (!clientId) return null;
  const { data } = await admin.from("profiles").select("id,first_name,last_name,phone").eq("id", clientId).maybeSingle();
  return data || null;
}

// ------------------------------------------------------------------
// Synchronisation agenda Google + feuille "Miss'U - Demandes (secours)"
// ------------------------------------------------------------------
async function syncBookingExternal(admin, rdvId) {
  const rdv = await getRdv(admin, rdvId);
  if (!rdv) throw httpError(404, "Rendez-vous introuvable.");
  const now = new Date().toISOString();
  let body = null;
  let transportError = null;
  try {
    const res = await fetchWithTimeout(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "syncBooking", rdvId }),
    }, 25000);
    const text = await res.text();
    try { body = JSON.parse(text); } catch { transportError = `Réponse Apps Script illisible (${res.status})`; }
    if (body && body.ok === false && !body.calendar && !body.sheet) transportError = body.error || "Apps Script : échec";
  } catch (e) {
    transportError = "Apps Script injoignable : " + (e.name === "AbortError" ? "délai dépassé" : e.message);
  }

  const patch = { agenda_derniere_tentative: now, agenda_tentatives: (rdv.agenda_tentatives || 0) + 1 };
  if (transportError) {
    if (rdv.agenda_statut !== "non_requis" && rdv.agenda_statut !== "ok" && rdv.agenda_statut !== "retire") {
      patch.agenda_statut = "erreur"; patch.agenda_erreur = transportError;
    }
    if (rdv.feuille_statut !== "non_requis" && rdv.feuille_statut !== "ok") {
      patch.feuille_statut = "erreur"; patch.feuille_erreur = transportError;
    }
  } else {
    if (body.calendar) {
      if (body.calendar.action === "removed" || body.calendar.action === "absent") {
        patch.agenda_statut = rdv.agenda_statut === "non_requis" ? "non_requis" : "retire";
        patch.agenda_evenement_id = null;
      } else if (body.calendar.eventId) {
        patch.agenda_statut = "ok"; patch.agenda_evenement_id = body.calendar.eventId;
      }
      patch.agenda_erreur = null;
    } else if (body.calendarError) {
      patch.agenda_statut = "erreur"; patch.agenda_erreur = String(body.calendarError).slice(0, 500);
    }
    if (body.sheet) {
      patch.feuille_statut = "ok"; patch.feuille_erreur = null;
      if (body.sheet.dossierId && !rdv.dossier_id) patch.dossier_id = body.sheet.dossierId;
    } else if (body.sheetError) {
      patch.feuille_statut = "erreur"; patch.feuille_erreur = String(body.sheetError).slice(0, 500);
    }
  }
  const { error } = await admin.from("rendez_vous").update(patch).eq("id", rdvId);
  if (error) console.error("[booking] enregistrement état synchro :", error.message);
  return { ...patch, transportError };
}

async function retryPendingSyncs(admin, { limit = 5, minDelayMs = 60000, maxAttempts = 50 } = {}) {
  const { data, error } = await admin.from("rendez_vous").select("id,agenda_statut,feuille_statut,agenda_tentatives,agenda_derniere_tentative")
    .or("agenda_statut.in.(a_synchroniser,erreur,a_retirer),feuille_statut.in.(a_synchroniser,erreur)")
    .lt("agenda_tentatives", maxAttempts)
    .order("agenda_derniere_tentative", { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) throw error;
  const due = (data || []).filter((r) => !r.agenda_derniere_tentative || Date.now() - new Date(r.agenda_derniere_tentative).getTime() >= minDelayMs);
  const out = { traites: 0, ok: 0, erreurs: 0 };
  for (const r of due) {
    out.traites++;
    try {
      const p = await syncBookingExternal(admin, r.id);
      if (p.transportError || p.agenda_statut === "erreur" || p.feuille_statut === "erreur") out.erreurs++;
      else out.ok++;
    } catch (e) {
      out.erreurs++;
    }
  }
  return out;
}

function requestBody(req) {
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body || "{}"); } catch { body = {}; } }
  return body || {};
}

function clean(v, max = 120) {
  return String(v ?? "").trim().slice(0, max);
}

module.exports = {
  TZ, SITE_ORIGIN, APPS_SCRIPT_URL, DEFAULT_SETTINGS, SERVICE_LABELS, STATUT_LABELS, PAYMENT_LABELS,
  httpError, serviceLabel, zoned, localToDate, addDaysStr, todayLocal, longDateFmt, DATE_RE, TIME_RE,
  loadSettings, loadPrestation, fetchCalendarBusy, sumupGetCheckout, sumupDeactivate, checkoutIsPaid, checkoutMatches,
  loadBlocked, getRdv, rpc, reconcilePayment, releaseHoldSafely, releaseExpiredHolds,
  computeSlots, remainingLimitedPlaces, validateBookingInput, assertSlotBookable, createHold, startPayment,
  bookingView, loadProfile, syncBookingExternal, retryPendingSyncs, requestBody, clean, overlaps,
};
