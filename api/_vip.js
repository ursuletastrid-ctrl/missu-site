// MYU VIP — logique partagée (demandes de créneau prioritaire).
// Fichier préfixé par "_" : Vercel n'en fait pas une route. Importé par
// api/vip.js (côté cliente) et api/admin-myu.js (côté Astrid).
//
// Règles de sécurité :
//  * une demande VIP n'est PAS un rendez-vous : aucun créneau n'est bloqué
//    et aucun paiement n'est possible tant qu'Astrid n'a pas accepté ;
//  * à l'acceptation, le créneau est maintenu `vip_maintien_heures` (48 h) ;
//  * le paiement n'est lancé que sur clic de la cliente, après acceptation,
//    avec la case de consentement cochée ;
//  * le statut "confirmé" ne vient QUE du paiement relu chez SumUp
//    (rendez_vous.payment_status = 'paye') ;
//  * aucune clé secrète n'est exposée : tout passe par le serveur ;
//  * aucun message (SMS, e-mail, WhatsApp) n'est envoyé automatiquement :
//    Astrid écrit à la cliente via un lien WhatsApp pré-rempli.

const crypto = require("crypto");
const B = require("./_booking");

const OPEN_STATUTS = ["en_attente", "contre_proposition", "accepte_attente_paiement"];
const STATUT_VIP_LABELS = {
  en_attente: "Demande reçue — Miss'U vous répond personnellement",
  contre_proposition: "Miss'U vous propose un autre créneau",
  accepte_attente_paiement: "Créneau réservé pour vous — acompte à régler",
  confirme: "Rendez-vous confirmé",
  refuse: "Demande non retenue",
  annule: "Demande annulée",
  expire: "Délai dépassé — créneau libéré",
};
const MAX_HEURE = "22:00";
const MIN_HEURE = "06:00";

const fullDateFmt = new Intl.DateTimeFormat("fr-FR", {
  timeZone: B.TZ, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
});

// ------------------------------------------------------------------
// Petits utilitaires
// ------------------------------------------------------------------
function phoneNorm(phone) {
  return String(phone || "").replace(/\D/g, "").slice(-9);
}

// Numéro au format international pour wa.me (Martinique 0596/0696 -> 596...).
function whatsappNumber(phone) {
  const raw = String(phone || "").trim();
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  if (raw.startsWith("+")) return digits;
  if (digits.startsWith("00")) return digits.slice(2);
  if (digits.length === 10 && digits.startsWith("0")) {
    return (digits.startsWith("0596") || digits.startsWith("0696") ? "596" : "33") + digits.slice(1);
  }
  return digits;
}

function ipHash(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = fwd || req.socket?.remoteAddress || "inconnue";
  return crypto.createHash("sha256").update(`${process.env.MYU_VIP_SALT || "myu-vip"}|${ip}`).digest("hex").slice(0, 32);
}

function dayLabel(date) {
  return date ? B.longDateFmt.format(B.localToDate(date, "12:00")) : null;
}

function money(n) {
  return `${Number(n || 0).toLocaleString("fr-FR", { maximumFractionDigits: 2 })} €`;
}

function suiviUrl(token) {
  return `${B.SITE_ORIGIN}/vip-suivi.html?t=${encodeURIComponent(token)}`;
}

async function loadVipSettings(admin) {
  const settings = await B.loadSettings(admin);
  return {
    settings,
    supplement: Math.min(200, Math.max(0, Number(settings.vip_supplement_eur) || 0)),
    maintienHeures: Math.min(168, Math.max(1, Number(settings.vip_maintien_heures) || 48)),
  };
}

async function getDemandeByToken(admin, token) {
  const t = B.clean(token, 100);
  if (!/^[0-9a-f]{40,100}$/i.test(t)) throw B.httpError(404, "Lien de suivi invalide.");
  const { data, error } = await admin.from("myu_demandes_vip").select("*").eq("suivi_token", t).maybeSingle();
  if (error) throw error;
  if (!data) throw B.httpError(404, "Lien de suivi invalide.");
  return data;
}

async function getDemandeById(admin, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ""))) throw B.httpError(400, "Demande invalide.");
  const { data, error } = await admin.from("myu_demandes_vip").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw B.httpError(404, "Demande introuvable.");
  return data;
}

async function updateDemande(admin, id, patch) {
  const { data, error } = await admin.from("myu_demandes_vip")
    .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select().single();
  if (error) throw error;
  return data;
}

// ------------------------------------------------------------------
// Synchronisation demande <-> rendez-vous (paiement relu chez SumUp)
// ------------------------------------------------------------------
async function syncDemande(admin, d) {
  if (!d || d.statut !== "accepte_attente_paiement" || !d.rdv_id) return d;
  let rdv = await B.getRdv(admin, d.rdv_id);
  if (!rdv) return updateDemande(admin, d.id, { statut: "annule", reponse_admin: d.reponse_admin });

  // 1. Un paiement a-t-il abouti ? (relecture SumUp si un checkout existe)
  if (rdv.payment_status !== "paye" && rdv.payment_reference && rdv.statut === "en_attente_paiement") {
    try { rdv = (await B.reconcilePayment(admin, rdv)).rdv || rdv; }
    catch (e) { console.error("[vip] rapprochement paiement :", e.message); }
  }
  if (rdv.payment_status === "paye") {
    return updateDemande(admin, d.id, { statut: "confirme" });
  }

  // 2. Délai de 48 h dépassé sans paiement : libération vérifiée chez SumUp.
  const expired = d.expire_le && new Date(d.expire_le) < new Date();
  if (expired && rdv.statut === "en_attente_paiement") {
    try { rdv = (await B.releaseHoldSafely(admin, rdv, "Créneau VIP non confirmé dans le délai (vérifié chez SumUp)")).rdv || rdv; }
    catch (e) { console.error("[vip] libération :", e.message); }
    if (rdv.payment_status === "paye") return updateDemande(admin, d.id, { statut: "confirme" });
  }
  if (rdv.statut === "annule" && rdv.payment_status !== "paye") {
    return updateDemande(admin, d.id, { statut: expired ? "expire" : "annule" });
  }
  if (rdv.statut === "confirme" && rdv.payment_status === "paye") {
    return updateDemande(admin, d.id, { statut: "confirme" });
  }
  return d;
}

// ------------------------------------------------------------------
// Vues
// ------------------------------------------------------------------
async function prestationDeposit(admin, type) {
  try { return (await B.loadPrestation(admin, type)).deposit_amount; } catch { return null; }
}

// Ce que la cliente voit (jamais la note interne, ni les coordonnées d'autres personnes).
async function publicView(admin, d) {
  let rdv = null;
  if (d.rdv_id) rdv = await B.getRdv(admin, d.rdv_id).catch(() => null);
  const ouvert = d.statut === "accepte_attente_paiement";
  const acompteBase = rdv ? Number(rdv.deposit_amount) : await prestationDeposit(admin, d.type_prestation);
  const acompteTotal = rdv ? Number(rdv.deposit_amount) : (acompteBase == null ? null : acompteBase + Number(d.supplement_eur || 0));
  const dateRetenue = d.date_retenue || null;
  return {
    prenom: d.prenom,
    prestation: B.serviceLabel(d.type_prestation),
    lieu: d.lieu,
    statut: d.statut,
    statutLibelle: STATUT_VIP_LABELS[d.statut] || d.statut,
    souhait: { date: d.date_souhaitee, dateLongue: dayLabel(d.date_souhaitee), heure: d.heure_souhaitee },
    souhaitAlt: d.date_alt ? { date: d.date_alt, dateLongue: dayLabel(d.date_alt), heure: d.heure_alt } : null,
    retenu: dateRetenue ? { date: dateRetenue, dateLongue: dayLabel(dateRetenue), heure: d.heure_retenue } : null,
    reponse: d.reponse_admin || null,
    supplement: Number(d.supplement_eur || 0),
    acompteTotal,
    acompteLibelle: acompteTotal == null ? null : money(acompteTotal),
    expireLe: d.expire_le || null,
    expireLibelle: d.expire_le ? fullDateFmt.format(new Date(d.expire_le)) : null,
    maintienActif: ouvert && !!d.expire_le && new Date(d.expire_le) > new Date(),
    peutPayer: ouvert && !!d.expire_le && new Date(d.expire_le) > new Date() && acompteTotal > 0,
    peutAccepterContreProposition: d.statut === "contre_proposition",
    peutAnnuler: ["en_attente", "contre_proposition", "accepte_attente_paiement"].includes(d.statut),
    confirmeLe: d.statut === "confirme" && rdv ? rdv.payment_date || rdv.confirme_le || null : null,
  };
}

// Ce qu'Astrid voit dans l'onglet "Demandes VIP".
function adminView(d) {
  const num = whatsappNumber(d.telephone);
  const lien = suiviUrl(d.suivi_token);
  const base = `Bonjour ${d.prenom}, c'est Miss'U (MYU). `;
  const prestation = B.serviceLabel(d.type_prestation);
  const souhait = `${dayLabel(d.date_souhaitee)} à ${d.heure_souhaitee}`;
  let texte;
  if (d.statut === "accepte_attente_paiement") {
    texte = `${base}Votre créneau VIP (${prestation}) du ${dayLabel(d.date_retenue || d.date_souhaitee)} à ${d.heure_retenue || d.heure_souhaitee} est réservé pour vous jusqu'au ${d.expire_le ? fullDateFmt.format(new Date(d.expire_le)) : "délai prévu"}. Pour le confirmer, réglez l'acompte ici : ${lien}`;
  } else if (d.statut === "contre_proposition") {
    texte = `${base}Je ne peux pas à l'heure demandée, mais je vous propose le ${dayLabel(d.date_retenue)} à ${d.heure_retenue}. Dites-moi si cela vous convient ici : ${lien}`;
  } else if (d.statut === "refuse") {
    texte = `${base}Merci pour votre demande VIP (${prestation}, ${souhait}). Je ne peux malheureusement pas la retenir. Je reste disponible pour trouver un autre créneau.`;
  } else {
    texte = `${base}J'ai bien reçu votre demande VIP (${prestation}, ${souhait}). Je reviens vers vous très vite. Suivi : ${lien}`;
  }
  return {
    id: d.id,
    creeLe: d.created_at,
    statut: d.statut,
    statutLibelle: STATUT_VIP_LABELS[d.statut] || d.statut,
    prenom: d.prenom, nom: d.nom, telephone: d.telephone, email: d.email || "",
    typePrestation: d.type_prestation, prestation, lieu: d.lieu,
    dateSouhaitee: d.date_souhaitee, heureSouhaitee: d.heure_souhaitee,
    souhaitLibelle: souhait,
    dateAlt: d.date_alt, heureAlt: d.heure_alt,
    souhaitAltLibelle: d.date_alt ? `${dayLabel(d.date_alt)} à ${d.heure_alt}` : null,
    historique: [
      { quand: d.created_at, texte: "Demande reçue" },
      d.traite_le && d.statut !== "en_attente" ? { quand: d.traite_le, texte: `Réponse : ${(STATUT_VIP_LABELS[d.statut] || d.statut)}` } : null,
      d.accepte_le ? { quand: d.accepte_le, texte: "Créneau accepté et maintenu" } : null,
      d.statut === "confirme" ? { quand: d.updated_at, texte: "Acompte payé — rendez-vous confirmé" } : null,
    ].filter(Boolean),
    dateRetenue: d.date_retenue, heureRetenue: d.heure_retenue,
    message: d.message || "",
    reponse: d.reponse_admin || "", noteInterne: d.note_interne || "",
    supplement: Number(d.supplement_eur || 0),
    expireLe: d.expire_le, expireLibelle: d.expire_le ? fullDateFmt.format(new Date(d.expire_le)) : null,
    rdvId: d.rdv_id,
    lienSuivi: lien,
    whatsapp: num ? `https://wa.me/${num}?text=${encodeURIComponent(texte)}` : "",
    texteWhatsapp: texte,
  };
}

// ------------------------------------------------------------------
// Création d'une demande (côté cliente)
// ------------------------------------------------------------------
async function createDemande(admin, req, body) {
  // Champ piège : un robot le remplit, une personne ne le voit pas.
  if (B.clean(body.website, 50)) return { ignore: true };

  const prenom = B.clean(body.firstName, 60);
  const nom = B.clean(body.lastName, 60);
  const telephone = B.clean(body.phone, 30);
  const email = B.clean(body.email, 160).toLowerCase();
  const type = B.clean(body.typePrestation, 80);
  const lieuBody = B.clean(body.lieu, 80);
  const dateRdv = B.clean(body.dateRdv, 10);
  const heureRdv = B.clean(body.heureRdv, 5);
  const message = B.clean(body.message, 500);
  const dateAlt = B.clean(body.dateAlt, 10);
  const heureAlt = B.clean(body.heureAlt, 5);

  if (!prenom || !telephone) throw B.httpError(400, "Prénom et téléphone sont requis.");
  if (!/^[+\d][\d\s.-]{5,}$/.test(telephone) || phoneNorm(telephone).length < 8) throw B.httpError(400, "Numéro de téléphone invalide.");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw B.httpError(400, "Email invalide.");
  if (body.consent !== true) throw B.httpError(400, "Votre accord est requis pour envoyer la demande et être recontactée.");
  if (!type) throw B.httpError(400, "Choisissez une prestation.");
  if (!B.DATE_RE.test(dateRdv)) throw B.httpError(400, "Choisissez un jour.");
  if (!B.TIME_RE.test(heureRdv)) throw B.httpError(400, "Choisissez une heure.");
  if (heureRdv < MIN_HEURE || heureRdv > MAX_HEURE) throw B.httpError(400, `Choisissez une heure entre ${MIN_HEURE} et ${MAX_HEURE}.`);
  // Second créneau facultatif : les deux champs ensemble, ou aucun.
  if (Boolean(dateAlt) !== Boolean(heureAlt)) throw B.httpError(400, "Pour le second créneau, indiquez le jour ET l'heure (ou laissez les deux vides).");
  if (dateAlt && (!B.DATE_RE.test(dateAlt) || !B.TIME_RE.test(heureAlt) || heureAlt < MIN_HEURE || heureAlt > MAX_HEURE)) throw B.httpError(400, "Second créneau invalide.");
  if (dateAlt && dateAlt === dateRdv && heureAlt === heureRdv) throw B.httpError(400, "Le second créneau doit être différent du premier.");

  const { settings } = await loadVipSettings(admin);
  const prestation = await B.loadPrestation(admin, type); // lève 400 si inactive
  if (prestation.is_limited_offer) throw B.httpError(400, "Cette offre ne se réserve pas en VIP.");
  const lieu = lieuBody || settings.lieux[0];
  if (!settings.lieux.includes(lieu)) throw B.httpError(400, "Ce lieu n'est pas proposé.");

  const now = new Date();
  const debut = B.localToDate(dateRdv, heureRdv); // lève 400 si invalide
  if (debut.getTime() < now.getTime() + 60 * 60000) throw B.httpError(400, "Choisissez un créneau dans le futur (au moins 1 h à l'avance).");
  if (dateRdv > B.addDaysStr(B.todayLocal(now), settings.horizon_jours)) throw B.httpError(400, `Les demandes sont possibles jusqu'à ${settings.horizon_jours} jours à l'avance.`);
  if (dateAlt) {
    const altDebut = B.localToDate(dateAlt, heureAlt);
    if (altDebut.getTime() < now.getTime() + 60 * 60000 || dateAlt > B.addDaysStr(B.todayLocal(now), settings.horizon_jours)) throw B.httpError(400, "Second créneau invalide (trop proche ou trop lointain).");
  }

  // Limites anti-abus
  const hash = ipHash(req);
  const since = new Date(now.getTime() - 3600 * 1000).toISOString();
  const { count: recent, error: e1 } = await admin.from("myu_demandes_vip")
    .select("id", { count: "exact", head: true }).eq("ip_hash", hash).gt("created_at", since);
  if (e1) throw e1;
  if ((recent || 0) >= 5) throw B.httpError(429, "Trop de demandes en peu de temps. Réessayez plus tard ou contactez MYU directement.");
  const norm = phoneNorm(telephone);
  const { count: ouvertes, error: e2 } = await admin.from("myu_demandes_vip")
    .select("id", { count: "exact", head: true }).eq("telephone_norm", norm).in("statut", OPEN_STATUTS);
  if (e2) throw e2;
  if ((ouvertes || 0) >= 3) throw B.httpError(429, "Vous avez déjà plusieurs demandes VIP en cours. Miss'U vous répond dès que possible.");

  const { data, error } = await admin.from("myu_demandes_vip").insert({
    prenom, nom, telephone, telephone_norm: norm, email: email || null,
    type_prestation: type, lieu, date_souhaitee: dateRdv, heure_souhaitee: heureRdv, date_alt: dateAlt || null, heure_alt: heureAlt || null, message: message || null,
    consentement_le: now.toISOString(),
    consentement_texte: "J'accepte d'être recontactée au sujet de cette demande VIP. Aucun paiement n'est demandé avant l'acceptation du créneau par Miss'U.",
    ip_hash: hash,
  }).select().single();
  if (error) {
    if (error.code === "23505") throw B.httpError(409, "Une demande identique (même téléphone, même prestation, même jour) est déjà en cours. Miss'U vous répondra.");
    throw error;
  }
  return { demande: data };
}

// ------------------------------------------------------------------
// Acceptation (Astrid, ou la cliente qui accepte une contre-proposition)
// ------------------------------------------------------------------
function referralCode(firstName) {
  const base = B.clean(firstName, 10).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z]/g, "") || "MYU";
  return `MYU-${base}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

// Crée la fiche cliente, bloque le créneau `vip_maintien_heures` et lie le rendez-vous à la demande.
// Le créneau est vérifié libre (agenda + autres rendez-vous) ; la contrainte SQL
// d'exclusion garantit l'absence de chevauchement même en cas de course.
async function holdSlotForDemande(admin, d, { dateRdv, heureRdv, supplement }) {
  const { settings, maintienHeures } = await loadVipSettings(admin);
  const prestation = await B.loadPrestation(admin, d.type_prestation);
  const total = Number(prestation.deposit_amount) + Number(supplement || 0);
  if (!(total > 0)) {
    throw B.httpError(400, "Cette prestation n'a pas d'acompte : ajoutez un supplément VIP ou confirmez le rendez-vous manuellement.");
  }
  const input = { typePrestation: d.type_prestation, lieu: d.lieu, dateRdv, heureRdv };
  B.validateBookingInput(input);
  const debut = B.localToDate(dateRdv, heureRdv);
  const fin = new Date(debut.getTime() + prestation.duree_minutes * 60000);
  if (debut.getTime() < Date.now()) throw B.httpError(400, "Ce créneau est déjà passé.");
  await B.assertRangeFree(admin, { debut, fin, settings });

  const guestEmail = `vip-${Date.now()}-${Math.random().toString(36).slice(2, 9)}@guest.myu.local`;
  const password = `${Math.random().toString(36).slice(2)}A!9${Date.now()}`;
  const { data: authData, error: authErr } = await admin.auth.admin.createUser({
    email: guestEmail, password, email_confirm: true,
    user_metadata: { first_name: d.prenom, last_name: d.nom, phone: d.telephone, contact_email: d.email || "", source: "vip" },
  });
  if (authErr || !authData?.user) throw authErr || new Error("Création cliente impossible");
  const guestId = authData.user.id;
  let rdv = null;
  try {
    const { error: pErr } = await admin.from("profiles").upsert({
      id: guestId, first_name: d.prenom, last_name: d.nom, phone: d.telephone, city: "", referral_code: referralCode(d.prenom),
    }, { onConflict: "id" });
    if (pErr) throw pErr;
    rdv = await B.createHold(admin, {
      clientId: guestId, input, contactEmail: d.email || "", settings, prestation,
      maintienMinutes: maintienHeures * 60, depositAmount: total, extra: { vip_demande_id: d.id },
    });
  } catch (e) {
    if (!rdv) await admin.auth.admin.deleteUser(guestId).catch(() => {});
    throw e;
  }
  return rdv;
}

async function acceptDemande(admin, d, { supplement, reponse }) {
  const rdv = await holdSlotForDemande(admin, d, { dateRdv: d.date_souhaitee, heureRdv: d.heure_souhaitee, supplement });
  return updateDemande(admin, d.id, {
    statut: "accepte_attente_paiement", rdv_id: rdv.id,
    date_retenue: d.date_souhaitee, heure_retenue: d.heure_souhaitee,
    supplement_eur: Number(supplement || 0), reponse_admin: reponse || d.reponse_admin || null,
    accepte_le: new Date().toISOString(), traite_le: new Date().toISOString(), expire_le: rdv.maintien_expire_le,
  });
}

// ------------------------------------------------------------------
// Paiement de l'acompte (clic de la cliente, après acceptation)
// ------------------------------------------------------------------
async function startDemandePayment(admin, d) {
  if (d.statut !== "accepte_attente_paiement" || !d.rdv_id) throw B.httpError(409, "Le paiement n'est pas encore ouvert pour cette demande.");
  if (!d.expire_le || new Date(d.expire_le) <= new Date()) throw B.httpError(409, "Le délai de confirmation est dépassé.");
  let rdv = await B.getRdv(admin, d.rdv_id);
  if (!rdv || rdv.statut !== "en_attente_paiement" || !rdv.bloque) throw B.httpError(409, "Ce créneau n'est plus réservé.");
  if (rdv.payment_status === "paye") throw B.httpError(409, "L'acompte est déjà réglé.");
  if (!(Number(rdv.deposit_amount) > 0)) throw B.httpError(409, "Aucun acompte à régler.");

  // Un paiement a-t-il déjà été entamé ?
  if (rdv.payment_reference) {
    const r = await B.reconcilePayment(admin, rdv);
    if (r.etat === "paye") return { dejaPaye: true };
    if (r.etat === "en_attente" && r.checkout?.hosted_checkout_url) return { checkoutUrl: r.checkout.hosted_checkout_url };
    if (r.etat !== "en_attente") throw B.httpError(409, "Ce paiement ne peut plus être repris. Contactez MYU.");
    throw B.httpError(409, "Un paiement est déjà en cours. Terminez-le depuis la page de paiement ouverte, ou contactez MYU.");
  }
  const checkoutUrl = await B.startPayment(admin, rdv, {
    redirectUrl: `${B.SITE_ORIGIN}/vip-suivi.html?t=${encodeURIComponent(d.suivi_token)}&paid=1`,
    keepHoldOnFailure: true,
  });
  return { checkoutUrl };
}

// Annulation : le créneau n'est libéré qu'après vérification qu'aucun paiement n'a abouti.
async function cancelDemande(admin, d, { statut = "annule", reponse } = {}) {
  if (!OPEN_STATUTS.includes(d.statut)) throw B.httpError(409, "Cette demande ne peut plus être annulée.");
  if (d.statut === "accepte_attente_paiement" && d.rdv_id) {
    const rdv = await B.getRdv(admin, d.rdv_id);
    const r = await B.releaseHoldSafely(admin, rdv, "Demande VIP annulée (vérifié chez SumUp)");
    if (r.etat === "paye") return syncDemande(admin, d);
    if (r.etat !== "libere" && r.etat !== "inchange" && r.etat !== "sans_paiement") {
      throw B.httpError(409, "Le paiement est en cours de vérification : impossible d'annuler pour le moment.");
    }
  }
  return updateDemande(admin, d.id, { statut, reponse_admin: reponse != null ? reponse : d.reponse_admin, traite_le: new Date().toISOString(), expire_le: null });
}

module.exports = {
  OPEN_STATUTS, STATUT_VIP_LABELS, phoneNorm, whatsappNumber, suiviUrl, loadVipSettings,
  getDemandeByToken, getDemandeById, updateDemande, syncDemande, publicView, adminView,
  createDemande, holdSlotForDemande, acceptDemande, startDemandePayment, cancelDemande, dayLabel,
};
