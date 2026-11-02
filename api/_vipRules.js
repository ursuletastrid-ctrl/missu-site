// MYU VIP — Private Experience : règles métier pures (prix, dates, horaires, quota).
// Fichier préfixé par "_" : Vercel n'en fait pas une route.
//
// Principe : la page web n'est qu'un affichage. TOUT ce qui touche à l'argent,
// aux dates ouvertes, aux plages horaires et au quota est recalculé ici, côté serveur.

const B = require("./_booking");

const ACOMPTE_TAUX = 0.5; // acompte = 50 % du prix total accepté (système existant)
const MIN_HEURE = "05:00";
const MAX_HEURE = "23:30";
const DEFAULT_COMPLET = "Les expériences privées de cette période sont actuellement complètes.";
const DATE_PREMIERE_DISPO = "2026-11-07"; // samedi 7 novembre 2026
// Prestations affichées « à partir de » sur le site : le prix dépend des zones,
// donc Miss'U confirme le montant exact (devis) avant tout paiement.
const A_PARTIR_DE = new Set(["taches_brunes_corps", "vergetures", "soins_corps_infrarouge"]);

const FORMULES_PAR_DEFAUT = [
  { code: "signature", nom: "VIP SIGNATURE", description: "Rendez-vous privé en soirée, dès 18 h.", supplement_eur: 60, sur_devis: false, plages: [{ de: "18:00", a: "19:59" }], plages_validees: true, actif: true, ordre: 1 },
  { code: "prestige", nom: "VIP PRESTIGE", description: "Rendez-vous privé, début de prestation entre 20 h et 21 h 59.", supplement_eur: 100, sur_devis: false, plages: [{ de: "20:00", a: "21:59" }], plages_validees: true, actif: true, ordre: 2 },
  { code: "exclusive", nom: "VIP EXCLUSIVE", description: "Rendez-vous à partir de 22 h : horaire exceptionnel, organisation particulière.", supplement_eur: 150, sur_devis: false, plages: [{ de: "22:00", a: "23:59" }], plages_validees: true, actif: true, ordre: 3 },
  { code: "sur_mesure", nom: "VIP SUR MESURE", description: "Horaires très matinaux ou demandes particulières : sur devis.", supplement_eur: null, sur_devis: true, plages: [], plages_validees: false, actif: true, ordre: 4 },
];

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const toMin = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + m; };
const fmtHeure = (t) => String(t).replace(":", "h");
const dayLabel = (date) => (date ? B.longDateFmt.format(B.localToDate(date, "12:00")) : null);

// ------------------------------------------------------------------
// Chargement (Supabase)
// ------------------------------------------------------------------
function normPlages(p) {
  if (!Array.isArray(p)) return [];
  return p.filter((r) => r && B.TIME_RE.test(String(r.de)) && B.TIME_RE.test(String(r.a))).map((r) => ({ de: r.de, a: r.a }));
}

function normFormule(f) {
  return {
    code: f.code, nom: f.nom, description: f.description || "",
    supplement_eur: f.sur_devis ? null : round2(f.supplement_eur || 0),
    sur_devis: !!f.sur_devis, plages: normPlages(f.plages), plages_validees: !!f.plages_validees,
    actif: f.actif !== false, ordre: Number(f.ordre) || 0,
  };
}

async function loadFormules(admin) {
  const { data, error } = await admin.from("myu_vip_formules").select("*").order("ordre", { ascending: true });
  if (error) throw error;
  const rows = (data && data.length ? data : FORMULES_PAR_DEFAUT).map(normFormule);
  return rows.sort((a, b) => a.ordre - b.ordre);
}

async function loadFormule(admin, code) {
  const formules = await loadFormules(admin);
  const f = formules.find((x) => x.code === String(code || ""));
  if (!f || !f.actif) throw B.httpError(400, "Choisissez une formule VIP.");
  return f;
}

function normParams(row) {
  const r = row || {};
  const jours = Array.isArray(r.jours_ouverts) ? r.jours_ouverts.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6) : [0, 1, 2, 3, 4, 5, 6];
  return {
    demandes_actives: r.demandes_actives !== false,
    date_premiere_dispo: r.date_premiere_dispo ? String(r.date_premiere_dispo).slice(0, 10) : DATE_PREMIERE_DISPO,
    quota_max: r.quota_max == null ? (row ? null : 3) : Number(r.quota_max),
    quota_periode: r.quota_periode === "mois" ? "mois" : "semaine",
    jours_ouverts: jours,
    dates_indisponibles: (Array.isArray(r.dates_indisponibles) ? r.dates_indisponibles : []).map((d) => String(d).slice(0, 10)).filter((d) => B.DATE_RE.test(d)),
    creneaux_bloques: (Array.isArray(r.creneaux_bloques) ? r.creneaux_bloques : []).filter((c) => c && B.DATE_RE.test(String(c.date))),
    message_complet: r.message_complet || DEFAULT_COMPLET,
  };
}

async function loadParams(admin) {
  const { data, error } = await admin.from("myu_vip_parametres").select("*").eq("id", 1).maybeSingle();
  if (error) throw error;
  return normParams(data);
}

// ------------------------------------------------------------------
// Prix : prestation + supplément de formule, acompte = 50 % du total
// ------------------------------------------------------------------
// Le prix de la prestation = 2 × son acompte en ligne (système existant : acompte = 50 %).
function prixPrestation(prestation) {
  return round2(Number(prestation.deposit_amount) * 2);
}

function quote({ prestation, formule, total }) {
  const base = prixPrestation(prestation);
  const aPartirDe = A_PARTIR_DE.has(prestation.type_prestation);
  const surDevis = !!formule.sur_devis;
  const supplement = surDevis ? 0 : round2(formule.supplement_eur || 0);
  const devisRequis = surDevis || aPartirDe;
  let totalFinal = null;
  if (total != null) totalFinal = round2(total);
  else if (!surDevis) totalFinal = round2(base + supplement);
  return {
    prixPrestation: base, supplement, total: totalFinal,
    acompte: totalFinal == null ? null : round2(totalFinal * ACOMPTE_TAUX),
    surDevis, aPartirDe, devisRequis,
  };
}

// ------------------------------------------------------------------
// Dates et horaires
// ------------------------------------------------------------------
function weekday(dateStr) { return new Date(`${dateStr}T12:00:00Z`).getUTCDay(); }

// Renvoie un message d'erreur (string) ou null si la date est ouverte.
function dateProblem(params, dateStr) {
  if (dateStr < params.date_premiere_dispo) {
    return `Les expériences privées débutent le ${dayLabel(params.date_premiere_dispo)}. Choisissez une date à partir de ce jour.`;
  }
  if (!params.jours_ouverts.includes(weekday(dateStr))) return "Ce jour n'est pas ouvert aux demandes d'expériences privées. Choisissez un autre jour.";
  if (params.dates_indisponibles.includes(dateStr)) return "Cette date n'est pas disponible. Choisissez un autre jour.";
  return null;
}

function plageLibelle(plages) {
  return normPlages(plages).map((r) => `${fmtHeure(r.de)} – ${fmtHeure(r.a)}`).join(" · ");
}

function inPlage(heure, r) {
  const h = toMin(heure), de = toMin(r.de), a = toMin(r.a);
  return de <= a ? h >= de && h <= a : h >= de || h <= a; // plage qui passe minuit : 22:00 → 06:00
}

// Renvoie un message d'erreur ou null. dureeMin = durée RÉELLE de la prestation : sert à détecter
// un chevauchement avec un créneau bloqué (la formule, elle, est déterminée par l'heure de DÉBUT).
function heureProblem(params, dateStr, heure, dureeMin = 30) {
  if (heure < MIN_HEURE || heure > MAX_HEURE) return `Choisissez une heure entre ${fmtHeure(MIN_HEURE)} et ${fmtHeure(MAX_HEURE)}.`;
  const s = toMin(heure), e = s + Math.max(30, dureeMin);
  for (const c of params.creneaux_bloques) {
    if (c.date !== dateStr) continue;
    if (!c.de || !c.a) return "Cet horaire n'est pas disponible. Proposez-en un autre.";
    if (s < toMin(c.a) && toMin(c.de) < e) return "Cet horaire n'est pas disponible. Proposez-en un autre.";
  }
  return null;
}

// Formule applicable = celle dont une plage ACTIVE (validée) contient l'heure de DÉBUT de la prestation.
// Aucune plage ne correspond (très tôt le matin, journée, demande particulière) -> formule « sur devis ».
function formuleForHeure(formules, heure) {
  const actives = formules.filter((f) => f.actif).sort((a, b) => a.ordre - b.ordre);
  const hit = actives.find((f) => !f.sur_devis && f.plages_validees && f.plages.some((r) => inPlage(heure, r)));
  if (hit) return hit;
  const devis = actives.find((f) => f.sur_devis);
  if (!devis) throw B.httpError(400, "Cet horaire n'est pas proposé en expérience privée. Choisissez un autre horaire.");
  return devis;
}

// Heure de fin réelle (durée configurée de la prestation) : "20:00" + 120 min -> { fin: "22:00", lendemain: false }.
function heureFin(heure, dureeMin) {
  const t = toMin(heure) + Number(dureeMin || 0);
  return { fin: `${String(Math.floor((t % 1440) / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`, lendemain: t >= 1440 };
}

// Estimation complète (utilisée par la page ET par l'enregistrement de la demande).
function estimation({ prestation, formules, heure }) {
  const formule = formuleForHeure(formules, heure);
  const q = quote({ prestation, formule });
  return { formule, ...q, dureeMinutes: Number(prestation.duree_minutes) || 180, ...heureFin(heure, prestation.duree_minutes) };
}

// ------------------------------------------------------------------
// Quota réel : seules comptent les expériences ACCEPTÉES (en attente de paiement ou confirmées)
// ------------------------------------------------------------------
function periodBounds(dateStr, periode) {
  if (periode === "mois") {
    const [y, m] = dateStr.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { debut: `${dateStr.slice(0, 8)}01`, fin: `${dateStr.slice(0, 8)}${String(last).padStart(2, "0")}` };
  }
  const wd = weekday(dateStr); // 0 = dimanche
  const sinceMonday = (wd + 6) % 7;
  const debut = B.addDaysStr(dateStr, -sinceMonday);
  return { debut, fin: B.addDaysStr(debut, 6) };
}

async function quotaState(admin, params, dateStr) {
  const { debut, fin } = periodBounds(dateStr, params.quota_periode);
  let utilises = 0;
  const { count, error } = await admin.from("myu_demandes_vip").select("id", { count: "exact", head: true })
    .in("statut", ["accepte_attente_paiement", "confirme"]).gte("date_retenue", debut).lte("date_retenue", fin);
  if (error) throw error;
  utilises = count || 0;
  const max = params.quota_max;
  return { max, periode: params.quota_periode, debut, fin, utilises, complet: max != null && utilises >= max };
}

// Jette 409 si la période de `dateStr` est complète.
async function assertQuotaOpen(admin, params, dateStr) {
  const q = await quotaState(admin, params, dateStr);
  if (q.complet) throw B.httpError(409, params.message_complet);
  return q;
}

// Règles communes (dates + horaire) -> lève 400 avec un message clair.
function assertSlotRules(params, dateStr, heure, dureeMin) {
  const dp = dateProblem(params, dateStr);
  if (dp) throw B.httpError(400, dp);
  const hp = heureProblem(params, dateStr, heure, dureeMin);
  if (hp) throw B.httpError(400, hp);
}

module.exports = {
  ACOMPTE_TAUX, MIN_HEURE, MAX_HEURE, DEFAULT_COMPLET, DATE_PREMIERE_DISPO, A_PARTIR_DE, FORMULES_PAR_DEFAUT,
  round2, toMin, dayLabel, normPlages, normFormule, loadFormules, loadFormule, normParams, loadParams,
  prixPrestation, quote, estimation, formuleForHeure, heureFin, weekday, dateProblem, heureProblem, plageLibelle, periodBounds, quotaState, assertQuotaOpen, assertSlotRules,
};
