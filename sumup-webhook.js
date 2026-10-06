// POST /api/sumup-webhook — notification SumUp (CHECKOUT_STATUS_CHANGED).
//
// SÉCURITÉ : la notification n'est pas signée. On n'en lit QUE l'identifiant
// du checkout, puis on relit le paiement directement chez SumUp avec notre clé
// (montant, devise, référence = id du rendez-vous, code marchand). Seule cette
// relecture confirme ou libère un créneau.
//
// IDEMPOTENCE : la confirmation passe par la fonction SQL myu_confirmer_paiement
// qui verrouille la ligne et ne traite qu'une seule fois un acompte. Une
// notification reçue plusieurs fois (ou en même temps que le retour de la
// cliente sur le site) ne crée ni double confirmation, ni double décompte de
// place, ni double événement d'agenda (l'événement est retrouvé par son
// identifiant de réservation côté Apps Script).
//
// La cliente n'a PAS besoin de revenir sur le site : cette notification suffit
// à confirmer la réservation, bloquer le créneau et lancer la synchronisation.

const { getAdminClient } = require("./_supabaseAdmin");
const B = require("./_booking");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée." });

  const body = B.requestBody(req);
  const checkoutId = B.clean(body.id, 100);
  if (!checkoutId) return res.status(200).json({ received: true });

  let admin;
  try { admin = getAdminClient(); }
  catch (e) {
    console.error("[sumup-webhook]", e.message);
    return res.status(500).json({ error: e.message });
  }

  try {
    const { data: rdv, error } = await admin.from("rendez_vous").select("*").eq("payment_reference", checkoutId).maybeSingle();
    if (error) throw error;
    if (!rdv) return res.status(200).json({ received: true });

    if (rdv.payment_status === "paye") {
      // Doublon : déjà confirmé. On s'assure juste que la synchro n'est pas restée en échec.
      if (["a_synchroniser", "erreur", "a_retirer"].includes(rdv.agenda_statut) || ["a_synchroniser", "erreur"].includes(rdv.feuille_statut)) {
        await B.syncBookingExternal(admin, rdv.id).catch(() => {});
      }
      return res.status(200).json({ received: true });
    }

    const result = await B.reconcilePayment(admin, rdv);
    if (result.etat === "incoherent") console.error(`[sumup-webhook] checkout incohérent ignoré (rdv ${rdv.id})`);
    return res.status(200).json({ received: true });
  } catch (e) {
    console.error("[sumup-webhook]", e.message);
    // Erreur transitoire (SumUp ou base injoignable) : SumUp retentera.
    return res.status(502).json({ error: "Vérification indisponible, nouvelle tentative attendue." });
  }
};
