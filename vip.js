// /api/vip — MYU VIP, côté cliente (aucune connexion nécessaire).
//
//   GET  ?action=catalogue        prestations proposables en VIP + lieux
//   POST ?action=create           { firstName, lastName, phone, email, typePrestation, lieu,
//                                   dateRdv, heureRdv, message, consent, website(piège) }
//                                 -> enregistre la DEMANDE. Aucun paiement, aucun créneau bloqué.
//   GET  ?action=status&t=<jeton> état de la demande (synchronisé avec le paiement SumUp)
//   POST ?action=pay&t=<jeton>    { consent }  la cliente confirme et paie l'acompte,
//                                 possible uniquement après acceptation d'Astrid
//   POST ?action=accept&t=<jeton> la cliente accepte la contre-proposition d'Astrid
//                                 (le créneau est alors maintenu 48 h, puis "pay")
//   POST ?action=cancel&t=<jeton> la cliente annule sa demande (créneau libéré après vérification SumUp)
//
// Le jeton de suivi (aléatoire, 64 caractères) n'est connu que de la cliente et d'Astrid.
// Aucune clé secrète n'est exposée ; aucun SMS/e-mail n'est envoyé automatiquement.

const { getAdminClient } = require("./_supabaseAdmin");
const B = require("./_booking");
const V = require("./_vip");

async function catalogue(admin) {
  const { settings } = await V.loadVipSettings(admin);
  const { data, error } = await admin.from("prestations_reservation")
    .select("type_prestation,deposit_amount,is_limited_offer,active,duree_minutes").eq("active", true);
  if (error) throw error;
  const prestations = (data || [])
    .filter((p) => !p.is_limited_offer)
    .map((p) => ({ type: p.type_prestation, label: B.serviceLabel(p.type_prestation), dureeMinutes: Number(p.duree_minutes) || 180, acompte: Number(p.deposit_amount) || 0 }));
  return { prestations, lieux: settings.lieux, horizonJours: settings.horizon_jours, fuseau: B.TZ };
}

async function status(admin, q) {
  let d = await V.getDemandeByToken(admin, q.t);
  d = await V.syncDemande(admin, d);
  return V.publicView(admin, d);
}

async function create(admin, req) {
  const out = await V.createDemande(admin, req, B.requestBody(req));
  // Champ piège rempli : réponse neutre, rien n'est enregistré.
  if (out.ignore) return { suiviUrl: null, enregistre: false };
  return { enregistre: true, suiviToken: out.demande.suivi_token, suiviUrl: V.suiviUrl(out.demande.suivi_token) };
}

async function pay(admin, req, q) {
  const body = B.requestBody(req);
  if (body.consent !== true) throw B.httpError(400, "Cochez la case d'accord pour confirmer et payer l'acompte.");
  let d = await V.getDemandeByToken(admin, q.t);
  d = await V.syncDemande(admin, d);
  if (d.statut === "confirme") return { dejaPaye: true };
  return V.startDemandePayment(admin, d);
}

async function acceptCounter(admin, req, q) {
  let d = await V.getDemandeByToken(admin, q.t);
  if (d.statut !== "contre_proposition" || !d.date_retenue || !d.heure_retenue) {
    throw B.httpError(409, "Il n'y a pas de proposition à accepter pour cette demande.");
  }
  const rdv = await V.holdSlotForDemande(admin, d, { dateRdv: d.date_retenue, heureRdv: d.heure_retenue, supplement: d.supplement_eur });
  d = await V.updateDemande(admin, d.id, {
    statut: "accepte_attente_paiement", rdv_id: rdv.id, accepte_le: new Date().toISOString(),
    traite_le: new Date().toISOString(), expire_le: rdv.maintien_expire_le,
  });
  return V.publicView(admin, d);
}

async function cancel(admin, q) {
  let d = await V.getDemandeByToken(admin, q.t);
  d = await V.syncDemande(admin, d);
  d = await V.cancelDemande(admin, d, { statut: "annule" });
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
    if (action === "catalogue" && req.method === "GET") data = await catalogue(admin);
    else if (action === "status" && req.method === "GET") data = await status(admin, q);
    else if (action === "create" && req.method === "POST") data = await create(admin, req);
    else if (action === "pay" && req.method === "POST") data = await pay(admin, req, q);
    else if (action === "accept" && req.method === "POST") data = await acceptCounter(admin, req, q);
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
