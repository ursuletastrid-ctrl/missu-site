// POST /api/create-checkout
// Crée une demande de rendez-vous liée à une prestation du catalogue et,
// si un acompte est requis, ouvre un paiement SumUp (hosted checkout) pour
// cet acompte. Ne fait JAMAIS confiance au navigateur pour le montant : le
// montant de l'acompte est relu depuis prestations_reservation (source de
// vérité, éditable par l'équipe MYU), jamais envoyé par le client.
//
// Corps attendu : { typePrestation, dateRdv?, heureRdv? }
// Réponse : { success: true, data: { rdvId, checkoutUrl } } — checkoutUrl
// est null quand aucun acompte n'est requis (la demande est alors déjà au
// statut "demande", visible immédiatement dans Mon Espace MYU).
//
// Sécurité places limitées ("MODÈLE MYU") : cette fonction ne décrémente
// JAMAIS le stock de places — elle vérifie juste, à titre indicatif, qu'il
// en reste au moment de la demande. La seule décrémentation réelle a lieu
// dans /api/sumup-webhook, de façon atomique (fonction Postgres
// reserve_modele_slot), après confirmation du paiement par SumUp lui-même.
// Ceci évite qu'une place soit bloquée par une simple ouverture de
// formulaire jamais payée.

const { getAdminClient, getCallerFromRequest } = require("./_supabaseAdmin");

function requestOrigin(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers["host"];
  return `${proto}://${host}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Méthode non autorisée." });
    return;
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    res.status(500).json({ error: e.message });
    return;
  }

  const caller = await getCallerFromRequest(req, admin);
  if (!caller) {
    res.status(401).json({ error: "Authentification requise." });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body || "{}"); } catch { body = {}; }
  }
  body = body || {};

  const typePrestation = (body.typePrestation || "").trim();
  const dateRdv = body.dateRdv || null;
  const heureRdv = body.heureRdv || null;

  if (!typePrestation) {
    res.status(400).json({ error: "Prestation requise." });
    return;
  }

  // Source de vérité pour le montant de l'acompte et la disponibilité :
  // jamais un montant envoyé par le navigateur.
  const { data: reservation, error: resaErr } = await admin
    .from("prestations_reservation")
    .select("*")
    .eq("type_prestation", typePrestation)
    .maybeSingle();

  if (resaErr) {
    console.error("[create-checkout] lecture prestations_reservation :", resaErr.message);
    res.status(500).json({ error: "Impossible de vérifier cette prestation pour le moment." });
    return;
  }
  if (!reservation || !reservation.active) {
    res.status(400).json({ error: "Cette prestation n'est pas disponible à la réservation en ligne." });
    return;
  }
  if (reservation.is_limited_offer && (reservation.available_slots ?? 0) <= 0) {
    res.status(409).json({ error: "Complet : il ne reste plus de place pour cette offre." });
    return;
  }

  const depositAmount = Number(reservation.deposit_amount) || 0;
  const initialStatut = depositAmount > 0 ? "en_attente_paiement" : "demande";
  const initialPaymentStatus = depositAmount > 0 ? "en_attente" : "non_requis";

  const { data: rdv, error: insertErr } = await admin
    .from("rendez_vous")
    .insert({
      client_id: caller.id,
      type_prestation: typePrestation,
      date_rdv: dateRdv,
      heure_rdv: heureRdv,
      statut: initialStatut,
      deposit_amount: depositAmount,
      payment_status: initialPaymentStatus,
    })
    .select()
    .single();

  if (insertErr) {
    // Contrainte rendez_vous_creneau_unique : quelqu'un vient de prendre ce créneau.
    if (insertErr.code === "23505") {
      res.status(409).json({ error: "Ce créneau vient d'être réservé, merci d'en choisir un autre." });
      return;
    }
    console.error("[create-checkout] création rendez_vous :", insertErr.message);
    res.status(500).json({ error: "La demande n'a pas pu être enregistrée." });
    return;
  }

  if (depositAmount <= 0) {
    res.status(200).json({ success: true, data: { rdvId: rdv.id, checkoutUrl: null } });
    return;
  }

  const sumupApiKey = process.env.SUMUP_API_KEY;
  const sumupMerchantCode = process.env.SUMUP_MERCHANT_CODE;
  if (!sumupApiKey || !sumupMerchantCode) {
    console.error("[create-checkout] SUMUP_API_KEY ou SUMUP_MERCHANT_CODE manquant côté serveur.");
    await admin.from("rendez_vous").delete().eq("id", rdv.id);
    res.status(500).json({ error: "Le paiement en ligne n'est pas encore configuré. Merci de contacter MYU directement." });
    return;
  }

  let checkoutData;
  try {
    const sumupRes = await fetch("https://api.sumup.com/v0.1/checkouts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sumupApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        checkout_reference: rdv.id,
        amount: depositAmount,
        currency: "EUR",
        merchant_code: sumupMerchantCode,
        description: `Acompte réservation — ${typePrestation}`,
        // redirect_url : renvoie la navigatrice vers Mon Espace MYU après paiement.
        redirect_url: `${requestOrigin(req)}/?rdv=${rdv.id}`,
        // return_url : c'est le VRAI webhook — l'URL que SumUp appelle en
        // serveur-à-serveur pour notifier un changement de statut du paiement
        // (contrairement à redirect_url, qui ne concerne que le navigateur de
        // la cliente). SumUp n'a pas de webhook à enregistrer à l'avance dans
        // le tableau de bord : chaque checkout porte sa propre URL de rappel.
        return_url: `${requestOrigin(req)}/api/sumup-webhook`,
        hosted_checkout: { enabled: true },
      }),
    });
    checkoutData = await sumupRes.json().catch(() => null);
    if (!sumupRes.ok || !checkoutData?.id) {
      throw new Error(checkoutData?.message || `SumUp a répondu ${sumupRes.status}`);
    }
  } catch (e) {
    console.error("[create-checkout] échec création checkout SumUp :", e.message);
    await admin.from("rendez_vous").delete().eq("id", rdv.id);
    res.status(500).json({ error: "Le paiement n'a pas pu être initié. Merci de réessayer." });
    return;
  }

  const { error: updErr } = await admin
    .from("rendez_vous")
    .update({ payment_reference: checkoutData.id })
    .eq("id", rdv.id);
  if (updErr) {
    console.error("[create-checkout] enregistrement payment_reference :", updErr.message);
    // Le checkout SumUp existe déjà et reste utilisable ; on ne bloque pas la cliente pour ça.
  }

  res.status(200).json({
    success: true,
    data: { rdvId: rdv.id, checkoutUrl: checkoutData.hosted_checkout_url || null },
  });
};
