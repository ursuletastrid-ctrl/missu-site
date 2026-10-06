// POST /api/create-checkout — réservation avec acompte depuis "Mon Espace MYU"
// (cliente connectée). Même règle que /api/public-booking : prestation, lieu,
// jour et horaire obligatoires et re-vérifiés côté serveur, créneau maintenu
// pendant le paiement, montant de l'acompte relu en base (jamais envoyé par
// le navigateur).
//
// Corps attendu : { typePrestation, lieu, dateRdv, heureRdv }
// Réponse : { success: true, data: { rdvId, checkoutUrl } } — checkoutUrl est
// null quand aucun acompte n'est requis (le rendez-vous est alors confirmé).

const { getAdminClient, getCallerFromRequest } = require("./_supabaseAdmin");
const B = require("./_booking");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée." });

  let admin;
  try { admin = getAdminClient(); }
  catch (e) { return res.status(500).json({ error: e.message }); }

  const caller = await getCallerFromRequest(req, admin);
  if (!caller) return res.status(401).json({ error: "Authentification requise." });

  const body = B.requestBody(req);
  const input = {
    typePrestation: B.clean(body.typePrestation, 80),
    lieu: B.clean(body.lieu, 80),
    dateRdv: B.clean(body.dateRdv, 10),
    heureRdv: B.clean(body.heureRdv, 5),
  };

  try {
    const { settings, prestation } = await B.assertSlotBookable(admin, input);
    const rdv = await B.createHold(admin, { clientId: caller.id, input, contactEmail: caller.email || null, settings, prestation });
    if (prestation.deposit_amount <= 0) {
      await B.syncBookingExternal(admin, rdv.id).catch((e) => console.error("[create-checkout] synchro :", e.message));
      return res.status(200).json({ success: true, data: { rdvId: rdv.id, checkoutUrl: null } });
    }
    const checkoutUrl = await B.startPayment(admin, rdv, { redirectUrl: `${B.SITE_ORIGIN}/index.html?rdv=${encodeURIComponent(rdv.id)}` });
    return res.status(200).json({ success: true, data: { rdvId: rdv.id, checkoutUrl, maintienExpireLe: rdv.maintien_expire_le } });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error("[create-checkout]", e.message);
    const message = status === 503
      ? "Les disponibilités ne peuvent pas être vérifiées pour le moment. Merci de réessayer dans quelques minutes."
      : status < 500 || status === 502 ? e.message : "La demande n'a pas pu être enregistrée.";
    return res.status(status).json({ error: message });
  }
};
