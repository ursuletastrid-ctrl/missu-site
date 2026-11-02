// MYU VIP — Private Experience : logique partagée (demandes de rendez-vous privé).
// Fichier préfixé par "_" : Vercel n'en fait pas une route. Importé par
// api/vip.js (côté cliente) et api/admin-myu.js (côté Astrid).
//
// Règles de sécurité :
//  * une demande VIP n'est PAS un rendez-vous : aucun créneau n'est bloqué
//    et aucun paiement n'est possible tant qu'Astrid n'a pas accepté ;
//  * le prix (prestation + supplément de formule) et l'acompte (50 %) sont calculés
//    ici, côté serveur ; la page web ne fait qu'afficher ;
//  * une offre sur devis (VIP Sur mesure, ou prestation « à partir de ») ne peut jamais
//    être acceptée directement : Astrid propose un montant, la cliente l'accepte, puis paie ;
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
const R = require("./_vipRules");

const OPEN_STATUTS = ["en_attente", "contre_proposition", "accepte_attente_paiement"];
const STATUT_VIP_LABELS = {
  en_attente: "Demande reçue — Miss'U vous répond personnellement",
  contre_proposition: "Miss'U vous fait une proposition — à valider",
  accepte_attente_paiement: "Créneau réservé pour vous — acompte à régler",
  confirme: "Rendez-vous confirmé",
  refuse: "Demande non retenue",
  annule: "Demande annulée",
  expire: "Délai dépassé — créneau libéré",
};
const CONSENTEMENT_TEXTE = "J'accepte d'être recontactée au sujet de cette demande d'expérience privée. Je comprends que ma demande est soumise à confirmation de disponibilité et qu'aucun paiement n'est demandé avant son acceptation par Miss'U.";

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

const dayLabel = R.dayLabel;

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

// Journal des modifications. Un échec d'écriture du journal ne doit jamais bloquer une réservation.
async function logHist(admin, { demandeId = null, cible = "demande", acteur = "systeme", action, detail = null }) {
  try {
    const { error } = await admin.from("myu_vip_historique").insert({ demande_id: demandeId, cible, acteur, action, detail });
    if (error) console.error("[vip] historique :", error.message);
  } catch (e) { console.error("[vip] historique :", e.message); }
}

// Étiquettes de provenance du lien de pub (utm_*, ?presta=) : texte court, jamais de donnée personnelle.
function cleanTag(v) {
  return String(v == null ? "" : v).toLowerCase().replace(/[^a-z0-9_.\-]/g, "").slice(0, 60);
}
function cleanAttribution(a) {
  const x = a && typeof a === "object" ? a : {};
  return { pub_source: cleanTag(x.source) || null, pub_campagne: cleanTag(x.campaign) || null, pub_contenu: cleanTag(x.content) || null, pub_presta: cleanTag(x.presta) || null };
}

// Acompte d'une demande (anciennes demandes sans snapshot : acompte de la prestation + supplément).
function acompteOf(d, prestation) {
  if (d.acompte_eur != null) return Number(d.acompte_eur);
  return R.round2(Number(prestation.deposit_amount) + Number(d.supplement_eur || 0));
}

// ------------------------------------------------------------------
// Synchronisation demande <-> rendez-vous (paiement relu chez SumUp)
// ------------------------------------------------------------------
async function moveDemande(admin, d, patch, texte) {
  const upd = await updateDemande(admin, d.id, patch);
  if (texte) await logHist(admin, { demandeId: d.id, acteur: "systeme", action: texte });
  return upd;
}

async function syncDemande(admin, d) {
  if (!d || d.statut !== "accepte_attente_paiement" || !d.rdv_id) return d;
  let rdv = await B.getRdv(admin, d.rdv_id);
  if (!rdv) return moveDemande(admin, d, { statut: "annule", reponse_admin: d.reponse_admin }, "Rendez-vous introuvable : demande annulée");

  // 1. Un paiement a-t-il abouti ? (relecture SumUp si un checkout existe)
  if (rdv.payment_status !== "paye" && rdv.payment_reference && rdv.statut === "en_attente_paiement") {
    try { rdv = (await B.reconcilePayment(admin, rdv)).rdv || rdv; }
    catch (e) { console.error("[vip] rapprochement paiement :", e.message); }
  }
  if (rdv.payment_status === "paye") {
    return moveDemande(admin, d, { statut: "confirme" }, "Acompte payé (vérifié chez SumUp) — rendez-vous confirmé");
  }

  // 2. Délai de 48 h dépassé sans paiement : libération vérifiée chez SumUp.
  const expired = d.expire_le && new Date(d.expire_le) < new Date();
  if (expired && rdv.statut === "en_attente_paiement") {
    try { rdv = (await B.releaseHoldSafely(admin, rdv, "Créneau VIP non confirmé dans le délai (vérifié chez SumUp)")).rdv || rdv; }
    catch (e) { console.error("[vip] libération :", e.message); }
    if (rdv.payment_status === "paye") return moveDemande(admin, d, { statut: "confirme" }, "Acompte payé (vérifié chez SumUp) — rendez-vous confirmé");
  }
  if (rdv.statut === "annule" && rdv.payment_status !== "paye") {
    return moveDemande(admin, d, { statut: expired ? "expire" : "annule" }, expired ? "Délai dépassé sans paiement : créneau libéré" : "Rendez-vous annulé : créneau libéré");
  }
  if (rdv.statut === "confirme" && rdv.payment_status === "paye") {
    return moveDemande(admin, d, { statut: "confirme" }, "Rendez-vous confirmé");
  }
  return d;
}

// ------------------------------------------------------------------
// Vues
// ------------------------------------------------------------------
async function prestationOf(admin, type) {
  try { return await B.loadPrestation(admin, type); } catch { return null; }
}

// Ce que la cliente voit (jamais la note interne, ni les coordonnées d'autres personnes).
async function publicView(admin, d) {
  let rdv = null;
  if (d.rdv_id) rdv = await B.getRdv(admin, d.rdv_id).catch(() => null);
  const ouvert = d.statut === "accepte_attente_paiement";
  const total = d.prix_total_eur != null ? Number(d.prix_total_eur) : null;
  let acompte = d.acompte_eur != null ? Number(d.acompte_eur) : (rdv ? Number(rdv.deposit_amount) : null);
  if (acompte == null) {
    const p = await prestationOf(admin, d.type_prestation);
    if (p) acompte = acompteOf(d, p);
  }
  const dateRetenue = d.date_retenue || null;
  const surDevisFormule = d.formule_code === "sur_mesure";
  // Montant définitif encore à communiquer par Miss'U ?
  const montantAConfirmer = !!d.devis_requis && ["en_attente"].includes(d.statut);
  return {
    prenom: d.prenom,
    prestation: B.serviceLabel(d.type_prestation),
    lieu: d.lieu,
    formule: d.formule_code ? { code: d.formule_code, nom: d.formule_nom } : null,
    statut: d.statut,
    statutLibelle: STATUT_VIP_LABELS[d.statut] || d.statut,
    souhait: { date: d.date_souhaitee, dateLongue: dayLabel(d.date_souhaitee), heure: d.heure_souhaitee },
    souhaitAlt: d.date_alt ? { date: d.date_alt, dateLongue: dayLabel(d.date_alt), heure: d.heure_alt } : null,
    retenu: dateRetenue ? { date: dateRetenue, dateLongue: dayLabel(dateRetenue), heure: d.heure_retenue } : null,
    reponse: d.reponse_admin || null,
    prix: {
      prestation: d.prix_prestation_eur != null ? Number(d.prix_prestation_eur) : null,
      supplement: Number(d.supplement_eur || 0),
      total,
      totalLibelle: total == null ? "Sur devis" : money(total),
      surDevis: surDevisFormule && total == null,
      aPartirDe: montantAConfirmer && !surDevisFormule,
      montantAConfirmer,
    },
    supplement: Number(d.supplement_eur || 0),
    acompteTotal: acompte,
    acompteLibelle: acompte == null ? null : money(acompte),
    expireLe: d.expire_le || null,
    expireLibelle: d.expire_le ? fullDateFmt.format(new Date(d.expire_le)) : null,
    maintienActif: ouvert && !!d.expire_le && new Date(d.expire_le) > new Date(),
    peutPayer: ouvert && !!d.expire_le && new Date(d.expire_le) > new Date() && acompte > 0,
    peutAccepterContreProposition: d.statut === "contre_proposition" && acompte > 0,
    peutAnnuler: OPEN_STATUTS.includes(d.statut),
    confirmeLe: d.statut === "confirme" && rdv ? rdv.payment_date || rdv.confirme_le || null : null,
  };
}

// Ce qu'Astrid voit dans l'onglet « MYU VIP ». `extra` : { rdv, histo } (déjà chargés par vipList).
function adminView(d, extra = {}) {
  const rdv = extra.rdv || null;
  const num = whatsappNumber(d.telephone);
  const lien = suiviUrl(d.suivi_token);
  const base = `Bonjour ${d.prenom}, c'est Miss'U (MYU). `;
  const prestation = B.serviceLabel(d.type_prestation);
  const souhait = `${dayLabel(d.date_souhaitee)} à ${d.heure_souhaitee}`;
  const total = d.prix_total_eur != null ? Number(d.prix_total_eur) : null;
  const acompte = d.acompte_eur != null ? Number(d.acompte_eur) : (rdv ? Number(rdv.deposit_amount) : null);
  let texte;
  if (d.statut === "accepte_attente_paiement") {
    texte = `${base}Votre expérience privée (${prestation}) du ${dayLabel(d.date_retenue || d.date_souhaitee)} à ${d.heure_retenue || d.heure_souhaitee} est réservée pour vous jusqu'au ${d.expire_le ? fullDateFmt.format(new Date(d.expire_le)) : "délai prévu"}. Pour la confirmer, réglez l'acompte${acompte != null ? ` de ${money(acompte)}` : ""} ici : ${lien}`;
  } else if (d.statut === "contre_proposition") {
    texte = `${base}Voici ma proposition pour votre expérience privée : ${dayLabel(d.date_retenue)} à ${d.heure_retenue}${total != null ? `, pour un montant total de ${money(total)} (acompte ${money(acompte)})` : ""}. Vous pouvez l'accepter ici : ${lien}`;
  } else if (d.statut === "refuse") {
    texte = `${base}Merci pour votre demande d'expérience privée (${prestation}, ${souhait}). Je ne peux malheureusement pas la retenir. Je reste disponible pour trouver un autre créneau.`;
  } else {
    texte = `${base}J'ai bien reçu votre demande d'expérience privée (${prestation}, ${souhait}). Je reviens vers vous très vite. Suivi : ${lien}`;
  }
  const derived = [
    { quand: d.created_at, texte: "Demande reçue", acteur: "cliente" },
    d.traite_le && d.statut !== "en_attente" ? { quand: d.traite_le, texte: `Réponse : ${(STATUT_VIP_LABELS[d.statut] || d.statut)}`, acteur: "admin" } : null,
    d.accepte_le ? { quand: d.accepte_le, texte: "Créneau accepté et maintenu", acteur: "admin" } : null,
    d.statut === "confirme" ? { quand: d.updated_at, texte: "Acompte payé — rendez-vous confirmé", acteur: "systeme" } : null,
  ].filter(Boolean);
  const historique = extra.histo && extra.histo.length
    ? extra.histo.map((h) => ({ quand: h.created_at, texte: h.detail ? `${h.action} — ${h.detail}` : h.action, acteur: h.acteur }))
    : derived;
  let paiement = null;
  if (rdv) {
    paiement = {
      statut: rdv.payment_status, paye: rdv.payment_status === "paye",
      attendu: Number(rdv.deposit_amount) || 0, tentative: !!rdv.payment_reference,
      libelle: rdv.payment_status === "paye" ? `Acompte payé (${money(rdv.deposit_amount)}), vérifié chez SumUp`
        : rdv.payment_reference ? `Paiement commencé, non confirmé (${money(rdv.deposit_amount)} attendus)`
        : `Aucun paiement lancé (${money(rdv.deposit_amount)} attendus)`,
    };
  }
  return {
    id: d.id,
    creeLe: d.created_at,
    statut: d.statut,
    statutLibelle: STATUT_VIP_LABELS[d.statut] || d.statut,
    prenom: d.prenom, nom: d.nom, telephone: d.telephone, email: d.email || "",
    typePrestation: d.type_prestation, prestation, lieu: d.lieu,
    formule: d.formule_code ? { code: d.formule_code, nom: d.formule_nom } : null,
    prixPrestation: d.prix_prestation_eur != null ? Number(d.prix_prestation_eur) : null,
    supplement: Number(d.supplement_eur || 0),
    total, acompte, devisRequis: !!d.devis_requis,
    provenance: (d.pub_source || d.pub_campagne || d.pub_contenu || d.pub_presta)
      ? { source: d.pub_source || "", campagne: d.pub_campagne || "", contenu: d.pub_contenu || "", presta: d.pub_presta || "" } : null,
    prixAccepteLe: d.prix_accepte_le || null,
    paiement,
    dateSouhaitee: d.date_souhaitee, heureSouhaitee: d.heure_souhaitee,
    souhaitLibelle: souhait,
    dateAlt: d.date_alt, heureAlt: d.heure_alt,
    souhaitAltLibelle: d.date_alt ? `${dayLabel(d.date_alt)} à ${d.heure_alt}` : null,
    historique,
    dateRetenue: d.date_retenue, heureRetenue: d.heure_retenue,
    message: d.message || "",
    reponse: d.reponse_admin || "", noteInterne: d.note_interne || "",
    expireLe: d.expire_le, expireLibelle: d.expire_le ? fullDateFmt.format(new Date(d.expire_le)) : null,
    rdvId: d.rdv_id,
    lienSuivi: lien,
    whatsapp: num ? `https://wa.me/${num}?text=${encodeURIComponent(texte)}` : "",
    texteWhatsapp: texte,
  };
}

// ------------------------------------------------------------------
// Catalogue public + disponibilité d'une date (jamais de quota chiffré : pas de fausse rareté)
// ------------------------------------------------------------------
async function catalogue(admin) {
  const { settings } = await loadVipSettings(admin);
  const params = await R.loadParams(admin);
  const formules = await R.loadFormules(admin);
  const { data, error } = await admin.from("prestations_reservation")
    .select("type_prestation,deposit_amount,is_limited_offer,active,duree_minutes").eq("active", true);
  if (error) throw error;
  const prestations = (data || [])
    .filter((p) => !p.is_limited_offer && Number(p.deposit_amount) > 0) // sans acompte = pas d'expérience privée
    .map((p) => ({
      type: p.type_prestation, label: B.serviceLabel(p.type_prestation),
      dureeMinutes: Number(p.duree_minutes) || 180,
      prix: R.prixPrestation(p), acompte: Number(p.deposit_amount) || 0,
      aPartirDe: R.A_PARTIR_DE.has(p.type_prestation),
    }));
  return {
    actif: params.demandes_actives,
    dateMin: params.date_premiere_dispo,
    dateMinLongue: dayLabel(params.date_premiere_dispo),
    joursOuverts: params.jours_ouverts,
    datesIndisponibles: params.dates_indisponibles,
    messageComplet: params.message_complet,
    acompteTaux: R.ACOMPTE_TAUX,
    formules: formules.filter((f) => f.actif).map((f) => ({
      code: f.code, nom: f.nom, description: f.description,
      supplement: f.sur_devis ? null : f.supplement_eur, surDevis: f.sur_devis,
      // Les plages ne sont montrées (et appliquées) qu'une fois validées par Astrid.
      plages: f.plages_validees ? f.plages : [], plagesLibelle: f.plages_validees ? R.plageLibelle(f.plages) : "",
    })),
    prestations, lieux: settings.lieux, horizonJours: settings.horizon_jours, fuseau: B.TZ,
  };
}

// Estimation affichée avant l'envoi : prestation + supplément + total, formule déterminée par l'heure de début.
async function estimationPublique(admin, { type, heure }) {
  const t = B.clean(type, 80), h = B.clean(heure, 5);
  if (!t) throw B.httpError(400, "Choisissez une prestation.");
  if (!B.TIME_RE.test(h)) throw B.httpError(400, "Choisissez une heure.");
  const prestation = await B.loadPrestation(admin, t);
  if (prestation.is_limited_offer || !(Number(prestation.deposit_amount) > 0)) throw B.httpError(400, "Cette prestation ne se réserve pas en expérience privée.");
  const hp = R.heureProblem({ creneaux_bloques: [] }, "1970-01-01", h, prestation.duree_minutes);
  if (hp) throw B.httpError(400, hp);
  const e = R.estimation({ prestation, formules: await R.loadFormules(admin), heure: h });
  return {
    formule: { code: e.formule.code, nom: e.formule.nom },
    prixPrestation: e.prixPrestation, supplement: e.supplement, total: e.total, acompte: e.acompte,
    surDevis: e.surDevis, aPartirDe: e.aPartirDe, devisRequis: e.devisRequis,
    dureeMinutes: e.dureeMinutes, heureDebut: h, heureFin: e.fin, finLendemain: e.lendemain,
  };
}

async function disponibilite(admin, date) {
  const d = B.clean(date, 10);
  if (!B.DATE_RE.test(d)) throw B.httpError(400, "Date invalide.");
  const params = await R.loadParams(admin);
  if (!params.demandes_actives) return { date: d, ouvert: false, complet: false, message: "Les demandes d'expériences privées sont momentanément suspendues." };
  const dp = R.dateProblem(params, d);
  if (dp) return { date: d, ouvert: false, complet: false, message: dp };
  const q = await R.quotaState(admin, params, d);
  if (q.complet) return { date: d, ouvert: false, complet: true, message: params.message_complet };
  return { date: d, ouvert: true, complet: false, message: "" };
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
  // Second créneau facultatif : les deux champs ensemble, ou aucun.
  if (Boolean(dateAlt) !== Boolean(heureAlt)) throw B.httpError(400, "Pour le second créneau, indiquez le jour ET l'heure (ou laissez les deux vides).");
  if (dateAlt && (!B.DATE_RE.test(dateAlt) || !B.TIME_RE.test(heureAlt))) throw B.httpError(400, "Second créneau invalide.");
  if (dateAlt && dateAlt === dateRdv && heureAlt === heureRdv) throw B.httpError(400, "Le second créneau doit être différent du premier.");

  const { settings } = await loadVipSettings(admin);
  const params = await R.loadParams(admin);
  if (!params.demandes_actives) throw B.httpError(409, "Les demandes d'expériences privées sont momentanément suspendues. Merci de réessayer plus tard.");
  const prestation = await B.loadPrestation(admin, type); // lève 400 si inactive
  if (prestation.is_limited_offer) throw B.httpError(400, "Cette offre ne se réserve pas en expérience privée.");
  if (!(Number(prestation.deposit_amount) > 0)) throw B.httpError(400, "Cette prestation ne se réserve pas en expérience privée.");
  const lieu = lieuBody || settings.lieux[0];
  if (!settings.lieux.includes(lieu)) throw B.httpError(400, "Ce lieu n'est pas proposé.");

  // Dates ouvertes (à partir du 7 novembre), jours ouverts, dates indisponibles, plages, créneaux bloqués.
  R.assertSlotRules(params, dateRdv, heureRdv, prestation.duree_minutes);
  if (dateAlt) R.assertSlotRules(params, dateAlt, heureAlt, prestation.duree_minutes);

  const now = new Date();
  const debut = B.localToDate(dateRdv, heureRdv); // lève 400 si invalide
  if (debut.getTime() < now.getTime() + 60 * 60000) throw B.httpError(400, "Choisissez un créneau dans le futur (au moins 1 h à l'avance).");
  if (dateRdv > B.addDaysStr(B.todayLocal(now), settings.horizon_jours)) throw B.httpError(400, `Les demandes sont possibles jusqu'à ${settings.horizon_jours} jours à l'avance.`);
  if (dateAlt) {
    const altDebut = B.localToDate(dateAlt, heureAlt);
    if (altDebut.getTime() < now.getTime() + 60 * 60000 || dateAlt > B.addDaysStr(B.todayLocal(now), settings.horizon_jours)) throw B.httpError(400, "Second créneau invalide (trop proche ou trop lointain).");
  }

  // Quota réel de la période demandée.
  await R.assertQuotaOpen(admin, params, dateRdv);

  // Conflit d'agenda évident (durée RÉELLE de la prestation) : on prévient tout de suite la cliente.
  // Si l'agenda est injoignable, la demande est quand même enregistrée (Astrid revérifie à l'acceptation).
  try {
    await B.assertRangeFree(admin, { debut, fin: new Date(debut.getTime() + prestation.duree_minutes * 60000), settings });
  } catch (e) {
    if (e.status === 409) throw B.httpError(409, "Ce créneau n'est pas disponible. Proposez un autre horaire (ou un second créneau).");
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
  if ((ouvertes || 0) >= 3) throw B.httpError(429, "Vous avez déjà plusieurs demandes en cours. Miss'U vous répond dès que possible.");

  // Formule et prix : déterminés ICI par l'heure de DÉBUT de la prestation (jamais reçus du navigateur).
  const formules = await R.loadFormules(admin);
  const est = R.estimation({ prestation, formules, heure: heureRdv });
  const formule = est.formule, q = est;

  const { data, error } = await admin.from("myu_demandes_vip").insert({
    prenom, nom, telephone, telephone_norm: norm, email: email || null,
    type_prestation: type, lieu, date_souhaitee: dateRdv, heure_souhaitee: heureRdv, date_alt: dateAlt || null, heure_alt: heureAlt || null, message: message || null,
    formule_code: formule.code, formule_nom: formule.nom,
    prix_prestation_eur: q.prixPrestation, supplement_eur: q.supplement,
    prix_total_eur: q.total, acompte_eur: q.acompte, devis_requis: q.devisRequis,
    consentement_le: now.toISOString(), consentement_texte: CONSENTEMENT_TEXTE,
    ...cleanAttribution(body.attribution),
    ip_hash: hash,
  }).select().single();
  if (error) {
    if (error.code === "23505") throw B.httpError(409, "Une demande identique (même téléphone, même prestation, même jour) est déjà en cours. Miss'U vous répondra.");
    throw error;
  }
  await logHist(admin, {
    demandeId: data.id, acteur: "cliente", action: "Demande reçue",
    detail: `${formule.nom} · ${B.serviceLabel(type)} · ${dateRdv} ${heureRdv} · total estimé ${q.total == null ? "sur devis" : money(q.total)}${data.pub_campagne ? ` · pub : ${data.pub_campagne}` : ""}`,
  });
  return { demande: data, devis: q.devisRequis };
}

// ------------------------------------------------------------------
// Acceptation (Astrid, ou la cliente qui accepte une proposition)
// ------------------------------------------------------------------
function referralCode(firstName) {
  const base = B.clean(firstName, 10).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z]/g, "") || "MYU";
  return `MYU-${base}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

// Garde-fous communs à tout maintien de créneau : lancement 7/11 + quota réel.
async function assertCanHold(admin, dateRdv) {
  const params = await R.loadParams(admin);
  if (dateRdv < params.date_premiere_dispo) {
    throw B.httpError(400, `Les expériences privées débutent le ${dayLabel(params.date_premiere_dispo)}.`);
  }
  await R.assertQuotaOpen(admin, params, dateRdv);
  return params;
}

// Crée la fiche cliente, bloque le créneau `vip_maintien_heures` et lie le rendez-vous à la demande.
// Le créneau est vérifié libre (agenda + autres rendez-vous) ; la contrainte SQL
// d'exclusion garantit l'absence de chevauchement même en cas de course.
async function holdSlotForDemande(admin, d, { dateRdv, heureRdv, acompte }) {
  const { settings, maintienHeures } = await loadVipSettings(admin);
  const prestation = await B.loadPrestation(admin, d.type_prestation);
  const deposit = R.round2(acompte);
  if (!(deposit > 0)) throw B.httpError(400, "Aucun acompte à régler pour cette demande : confirmez le rendez-vous manuellement.");
  await assertCanHold(admin, dateRdv);
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
      maintienMinutes: maintienHeures * 60, depositAmount: deposit, extra: { vip_demande_id: d.id },
    });
  } catch (e) {
    if (!rdv) await admin.auth.admin.deleteUser(guestId).catch(() => {});
    throw e;
  }
  return rdv;
}

// Acceptation directe par Astrid : uniquement si le prix est déjà connu et fixé (pas de devis).
async function acceptDemande(admin, d, { reponse }) {
  if (d.statut !== "en_attente") throw B.httpError(409, "Cette demande n'est plus en attente.");
  if (d.devis_requis || d.prix_total_eur == null || d.acompte_eur == null) {
    throw B.httpError(409, "Cette demande nécessite un devis : utilisez « Proposer un devis / un créneau ». La personne devra accepter le montant avant de payer.");
  }
  const rdv = await holdSlotForDemande(admin, d, { dateRdv: d.date_souhaitee, heureRdv: d.heure_souhaitee, acompte: d.acompte_eur });
  const upd = await updateDemande(admin, d.id, {
    statut: "accepte_attente_paiement", rdv_id: rdv.id,
    date_retenue: d.date_souhaitee, heure_retenue: d.heure_souhaitee,
    reponse_admin: reponse || d.reponse_admin || null,
    accepte_le: new Date().toISOString(), traite_le: new Date().toISOString(), expire_le: rdv.maintien_expire_le,
  });
  await logHist(admin, { demandeId: d.id, acteur: "admin", action: "Demande acceptée, créneau maintenu", detail: `${d.date_souhaitee} ${d.heure_souhaitee} · total ${money(d.prix_total_eur)} · acompte ${money(d.acompte_eur)}` });
  return upd;
}

// Contre-proposition ou devis : Astrid fixe un créneau (et au besoin le montant total).
// Rien n'est maintenu ni facturé tant que la cliente n'a pas accepté.
async function proposeDemande(admin, d, { dateRdv, heureRdv, total, reponse }) {
  if (!["en_attente", "contre_proposition"].includes(d.statut)) throw B.httpError(409, "Cette demande n'est plus modifiable.");
  const date = B.clean(dateRdv, 10), heure = B.clean(heureRdv, 5);
  B.validateBookingInput({ typePrestation: d.type_prestation, lieu: d.lieu, dateRdv: date, heureRdv: heure });
  const prestation = await B.loadPrestation(admin, d.type_prestation);
  const debut = B.localToDate(date, heure);
  if (debut.getTime() < Date.now()) throw B.httpError(400, "Ce créneau est déjà passé.");

  // La formule (donc le supplément) suit l'heure de DÉBUT du créneau proposé.
  const formules = await R.loadFormules(admin);
  const est = R.estimation({ prestation, formules, heure });
  const formule = est.formule;
  let totalFinal;
  if (total !== undefined && total !== null && total !== "") {
    const n = Number(total);
    if (!Number.isFinite(n) || n <= 0 || n > 20000) throw B.httpError(400, "Montant total invalide.");
    totalFinal = R.round2(n);
  } else if (est.devisRequis) {
    // Offre sur devis : le montant doit être saisi explicitement (jamais deviné) ;
    // on ne le conserve que s'il a déjà été fixé pour la même formule.
    if (d.statut === "contre_proposition" && d.prix_total_eur != null && d.formule_code === formule.code) totalFinal = Number(d.prix_total_eur);
    else throw B.httpError(400, "Indiquez le montant total du devis (€) avant d'envoyer la proposition.");
  } else {
    totalFinal = est.total;
  }
  if (!(totalFinal > 0)) throw B.httpError(400, "Indiquez le montant total du devis (€).");
  const acompte = R.round2(totalFinal * R.ACOMPTE_TAUX);

  const params = await R.loadParams(admin);
  if (date < params.date_premiere_dispo) throw B.httpError(400, `Les expériences privées débutent le ${dayLabel(params.date_premiere_dispo)}.`);
  await R.assertQuotaOpen(admin, params, date);
  // La proposition doit être libre maintenant (elle n'est PAS maintenue avant l'accord de la cliente).
  await B.assertRangeFree(admin, { debut, fin: new Date(debut.getTime() + prestation.duree_minutes * 60000) });

  const supplement = formule.sur_devis ? 0 : est.supplement;
  const upd = await updateDemande(admin, d.id, {
    statut: "contre_proposition", date_retenue: date, heure_retenue: heure,
    formule_code: formule.code, formule_nom: formule.nom, prix_prestation_eur: est.prixPrestation, devis_requis: est.devisRequis || d.devis_requis,
    prix_total_eur: totalFinal, acompte_eur: acompte, supplement_eur: supplement,
    reponse_admin: reponse || null, traite_le: new Date().toISOString(), prix_accepte_le: null,
  });
  await logHist(admin, { demandeId: d.id, acteur: "admin", action: d.devis_requis ? "Devis envoyé" : "Proposition envoyée", detail: `${formule.nom} · ${date} ${heure} · total ${money(totalFinal)} · acompte ${money(acompte)}` });
  return upd;
}

// La cliente accepte la proposition (créneau + montant) : le créneau est maintenu `vip_maintien_heures`.
async function acceptProposal(admin, d) {
  if (d.statut !== "contre_proposition" || !d.date_retenue || !d.heure_retenue || d.acompte_eur == null) {
    throw B.httpError(409, "Il n'y a pas de proposition à accepter pour cette demande.");
  }
  const rdv = await holdSlotForDemande(admin, d, { dateRdv: d.date_retenue, heureRdv: d.heure_retenue, acompte: d.acompte_eur });
  const now = new Date().toISOString();
  const upd = await updateDemande(admin, d.id, {
    statut: "accepte_attente_paiement", rdv_id: rdv.id, accepte_le: now, traite_le: now,
    prix_accepte_le: now, expire_le: rdv.maintien_expire_le,
  });
  await logHist(admin, { demandeId: d.id, acteur: "cliente", action: "Proposition acceptée (créneau et montant), créneau maintenu", detail: `total ${money(d.prix_total_eur)} · acompte ${money(d.acompte_eur)}` });
  return upd;
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
  // Cohérence : l'acompte envoyé à SumUp est exactement celui que la cliente a accepté.
  if (d.acompte_eur != null && Math.abs(Number(rdv.deposit_amount) - Number(d.acompte_eur)) > 0.005) {
    throw B.httpError(409, "Le montant de l'acompte ne correspond plus à la demande. Contactez MYU.");
  }

  // Un paiement a-t-il déjà été entamé ?
  if (rdv.payment_reference) {
    const r = await B.reconcilePayment(admin, rdv);
    if (r.etat === "paye") return { dejaPaye: true };
    if (r.etat === "en_attente" && r.checkout?.hosted_checkout_url) return { checkoutUrl: r.checkout.hosted_checkout_url };
    if (r.etat !== "en_attente") throw B.httpError(409, "Ce paiement ne peut plus être repris. Contactez MYU.");
    throw B.httpError(409, "Un paiement est déjà en cours. Terminez-le depuis la page de paiement ouverte, ou contactez MYU.");
  }
  // La cliente a vu le prix total et coché la case : on garde la preuve de son accord.
  if (!d.prix_accepte_le) {
    await updateDemande(admin, d.id, { prix_accepte_le: new Date().toISOString() });
    await logHist(admin, { demandeId: d.id, acteur: "cliente", action: "Prix total accepté avant paiement", detail: `total ${money(d.prix_total_eur)} · acompte ${money(rdv.deposit_amount)}` });
  }
  const checkoutUrl = await B.startPayment(admin, rdv, {
    redirectUrl: `${B.SITE_ORIGIN}/vip-suivi.html?t=${encodeURIComponent(d.suivi_token)}&paid=1`,
    keepHoldOnFailure: true,
  });
  await logHist(admin, { demandeId: d.id, acteur: "cliente", action: "Paiement de l'acompte lancé (SumUp)" });
  return { checkoutUrl };
}

// Annulation : le créneau n'est libéré qu'après vérification qu'aucun paiement n'a abouti.
async function cancelDemande(admin, d, { statut = "annule", reponse, acteur = "cliente" } = {}) {
  if (!OPEN_STATUTS.includes(d.statut)) throw B.httpError(409, "Cette demande ne peut plus être annulée.");
  if (d.statut === "accepte_attente_paiement" && d.rdv_id) {
    const rdv = await B.getRdv(admin, d.rdv_id);
    const r = await B.releaseHoldSafely(admin, rdv, "Demande VIP annulée (vérifié chez SumUp)");
    if (r.etat === "paye") return syncDemande(admin, d);
    if (r.etat !== "libere" && r.etat !== "inchange" && r.etat !== "sans_paiement") {
      throw B.httpError(409, "Le paiement est en cours de vérification : impossible d'annuler pour le moment.");
    }
  }
  const upd = await updateDemande(admin, d.id, { statut, reponse_admin: reponse != null ? reponse : d.reponse_admin, traite_le: new Date().toISOString(), expire_le: null });
  await logHist(admin, { demandeId: d.id, acteur, action: statut === "refuse" ? "Demande refusée" : "Demande annulée, créneau libéré" });
  return upd;
}

async function refuseDemande(admin, d, { reponse }) {
  if (!["en_attente", "contre_proposition"].includes(d.statut)) throw B.httpError(409, "Cette demande n'est plus modifiable.");
  const upd = await updateDemande(admin, d.id, { statut: "refuse", reponse_admin: reponse || null, traite_le: new Date().toISOString() });
  await logHist(admin, { demandeId: d.id, acteur: "admin", action: "Demande refusée" });
  return upd;
}

module.exports = {
  OPEN_STATUTS, STATUT_VIP_LABELS, CONSENTEMENT_TEXTE, phoneNorm, whatsappNumber, suiviUrl, loadVipSettings,
  getDemandeByToken, getDemandeById, updateDemande, logHist, syncDemande, publicView, adminView, catalogue, disponibilite, estimationPublique,
  createDemande, holdSlotForDemande, acceptDemande, proposeDemande, acceptProposal, startDemandePayment, cancelDemande, refuseDemande,
  dayLabel, money,
};
