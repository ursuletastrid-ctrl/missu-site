// /api/vip — MYU VIP Private Experience, côté cliente (aucune connexion nécessaire).
//
//   GET  ?action=catalogue        formules, prestations (prix), dates ouvertes, lieux
//   GET  ?action=estimation&type=&heure=HH:MM   formule (déterminée par l'heure de début), prix, supplément, total, fin
//   GET  ?action=disponibilite&date=YYYY-MM-DD   date ouverte ? période complète ?
//   POST ?action=create           { firstName, lastName, phone, email, typePrestation, lieu,
//                                   dateRdv, heureRdv, dateAlt, heureAlt, message, consent, website(piège) }
//                                 -> enregistre la DEMANDE. Aucun paiement, aucun créneau bloqué.
//   GET  ?action=status&t=<jeton> état de la demande (synchronisé avec le paiement SumUp)
//   POST ?action=pay&t=<jeton>    { consent }  la cliente confirme le prix et paie l'acompte,
//                                 possible uniquement après acceptation
//   POST ?action=accept&t=<jeton> la cliente accepte la proposition de Miss'U (créneau + montant) :
//                                 le créneau est alors maintenu 48 h, puis "pay"
//   POST ?action=cancel&t=<jeton> la cliente annule sa demande (créneau libéré après vérification SumUp)
//
// Le jeton de suivi (aléatoire, 64 caractères) n'est connu que de la cliente et d'Astrid.
// Aucune clé secrète n'est exposée ; aucun SMS/e-mail n'est envoyé automatiquement.
// Le prix et l'acompte ne sont JAMAIS lus dans la requête : ils sont recalculés ici.

const { getAdminClient } = require("./_supabaseAdmin");
const B = require("./_booking");
const V = require("./_vip");

async function status(admin, q) {
  let d = await V.getDemandeByToken(admin, q.t);
  d = await V.syncDemande(admin, d);
  return V.publicView(admin, d);
}

async function create(admin, req) {
  const out = await V.createDemande(admin, req, B.requestBody(req));
  // Champ piège rempli : réponse neutre, rien n'est enregistré.
  if (out.ignore) return { suiviUrl: null, enregistre: false };
  return { enregistre: true, devis: !!out.devis, suiviToken: out.demande.suivi_token, suiviUrl: V.suiviUrl(out.demande.suivi_token) };
}

async function pay(admin, req, q) {
  const body = B.requestBody(req);
  if (body.consent !== true) throw B.httpError(400, "Cochez la case d'accord pour confirmer le montant et payer l'acompte.");
  let d = await V.getDemandeByToken(admin, q.t);
  d = await V.syncDemande(admin, d);
  if (d.statut === "confirme") return { dejaPaye: true };
  return V.startDemandePayment(admin, d);
}

async function acceptProposal(admin, q) {
  const d = await V.getDemandeByToken(admin, q.t);
  const upd = await V.acceptProposal(admin, d);
  return V.publicView(admin, upd);
}

async function cancel(admin, q) {
  let d = await V.getDemandeByToken(admin, q.t);
  d = await V.syncDemande(admin, d);
  d = await V.cancelDemande(admin, d, { statut: "annule", acteur: "cliente" });
  return V.publicView(admin, d);
}

module.exports = async function handler(req, res) {
  const q = req.query || {};
  const action = q.action || "";
  let admin;
  try { admin = getAdminClient(); }
  catch (e) { return res.status(500).json({ error: e.message }); }

  try {
    let data;
    if (action === "catalogue" && req.method === "GET") data = await V.catalogue(admin);
    else if (action === "estimation" && req.method === "GET") data = await V.estimationPublique(admin, q);
    else if (action === "disponibilite" && req.method === "GET") data = await V.disponibilite(admin, q.date);
    else if (action === "status" && req.method === "GET") data = await status(admin, q);
    else if (action === "create" && req.method === "POST") data = await create(admin, req);
    else if (action === "pay" && req.method === "POST") data = await pay(admin, req, q);
    else if (action === "accept" && req.method === "POST") data = await acceptProposal(admin, q);
    else if (action === "cancel" && req.method === "POST") data = await cancel(admin, q);
    else return res.status(400).json({ error: "Action inconnue." });
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ success: true, data });
  } catch (e) {
    const code = e.status || 500;
    if (code >= 500) console.error(`[vip] ${action} :`, e?.message || e);
    const message = code === 503
      ? "Les disponibilités ne peuvent pas être vérifiées pour le moment. Merci de réessayer dans quelques minutes."
      : code < 500 || code === 502 ? e.message : "Service momentanément indisponible. Merci de réessayer ou de contacter MYU.";
    return res.status(code).json({ error: message });
  }
};
