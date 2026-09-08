// POST /api/sumup-webhook
// Reçoit les notifications SumUp ("CHECKOUT_STATUS_CHANGED") et confirme
// (ou annule) l'acompte correspondant dans rendez_vous.
//
// SÉCURITÉ — RÈGLE ABSOLUE : les webhooks SumUp ne portent AUCUNE signature.
// On ne fait donc JAMAIS confiance au statut envoyé dans la notification :
// on ne fait que lire l'identifiant du checkout, puis on le RE-VÉRIFIE
// directement auprès de l'API SumUp (GET /v0.1/checkouts/{id}, avec notre
// clé API). C'est cette réponse — obtenue par NOUS, avec NOTRE clé — qui
// seule décide si un rendez-vous est confirmé. Un identifiant qui
// n'appartient pas à notre compte SumUp ne renverra rien d'exploitable.
//
// Idempotence : SumUp peut renvoyer plusieurs fois la même notification. Si
// le rendez-vous est déjà marqué payment_status = "paye", on ne retraite
// rien (évite de décrémenter deux fois le stock de places).
//
// Stock de places "MODÈLE MYU" : la décrémentation réelle (atomique, via la
// fonction Postgres reserve_modele_slot) n'a lieu ICI, et seulement après
// confirmation "PAID" par l'API SumUp — jamais avant.

const { getAdminClient } = require("./_supabaseAdmin");

async function fetchSumupCheckout(checkoutId) {
  const sumupApiKey = process.env.SUMUP_API_KEY;
  if (!sumupApiKey) {
    throw new Error("SUMUP_API_KEY manquante côté serveur.");
  }
  const res = await fetch(`https://api.sumup.com/v0.1/checkouts/${encodeURIComponent(checkoutId)}`, {
    headers: { Authorization: `Bearer ${sumupApiKey}` },
  });
  if (!res.ok) {
    throw new Error(`SumUp a répondu ${res.status} pour le checkout ${checkoutId}`);
  }
  return res.json();
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Méthode non autorisée." });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body || "{}"); } catch { body = {}; }
  }
  body = body || {};

  const checkoutId = body.id;
  if (!checkoutId) {
    // Notification qu'on ne comprend pas : on accuse réception sans rien faire,
    // plutôt que de provoquer des tentatives de renvoi infinies côté SumUp.
    res.status(200).json({ received: true });
    return;
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    console.error("[sumup-webhook]", e.message);
    res.status(500).json({ error: e.message });
    return;
  }

  const { data: rdv, error: findErr } = await admin
    .from("rendez_vous")
    .select("*")
    .eq("payment_reference", checkoutId)
    .maybeSingle();

  if (findErr) {
    console.error("[sumup-webhook] recherche rendez_vous :", findErr.message);
    res.status(500).json({ error: "Erreur serveur." });
    return;
  }
  if (!rdv) {
    // Checkout inconnu (test SumUp, ancien essai, etc.) : rien à faire ici.
    res.status(200).json({ received: true });
    return;
  }
  if (rdv.payment_status === "paye") {
    // Déjà traité — notification en doublon, on n'y retouche pas.
    res.status(200).json({ received: true });
    return;
  }

  let checkout;
  try {
    checkout = await fetchSumupCheckout(checkoutId);
  } catch (e) {
    console.error("[sumup-webhook] vérification SumUp :", e.message);
    // Erreur transitoire probable : on répond en erreur pour que SumUp retente.
    res.status(502).json({ error: "Vérification SumUp indisponible, nouvelle tentative attendue." });
    return;
  }

  const status = checkout?.status;

  // Un identifiant de checkout valide ne suffit pas : les données retournées
  // par SumUp doivent aussi correspondre exactement au rendez-vous enregistré.
  // Cela empêche qu'un autre paiement du même compte marchand confirme ce RDV.
  const expectedMerchant = process.env.SUMUP_MERCHANT_CODE;
  const amountMatches = Math.abs(Number(checkout?.amount) - Number(rdv.deposit_amount)) < 0.005;
  const currencyMatches = checkout?.currency === "EUR";
  const referenceMatches = String(checkout?.checkout_reference || "") === String(rdv.id);
  const merchantMatches = !expectedMerchant || String(checkout?.merchant_code || "") === String(expectedMerchant);

  if (!amountMatches || !currencyMatches || !referenceMatches || !merchantMatches) {
    console.error(`[sumup-webhook] checkout incohérent pour rdv ${rdv.id}`, {
      checkoutId,
      amountMatches,
      currencyMatches,
      referenceMatches,
      merchantMatches,
    });
    // On accuse réception pour ne pas provoquer de boucle de tentatives :
    // aucune donnée de paiement ni de rendez-vous n'est modifiée.
    res.status(200).json({ received: true });
    return;
  }

  if (status === "PAID") {
    let nextStatut = "confirme";

    if (rdv.type_prestation) {
      const { data: reservation, error: resaErr } = await admin
        .from("prestations_reservation")
        .select("is_limited_offer")
        .eq("type_prestation", rdv.type_prestation)
        .maybeSingle();

      if (!resaErr && reservation?.is_limited_offer) {
        const { data: remaining, error: rpcErr } = await admin.rpc("reserve_modele_slot", {
          p_type_prestation: rdv.type_prestation,
        });
        if (rpcErr) {
          console.error("[sumup-webhook] reserve_modele_slot :", rpcErr.message);
        }
        if (remaining === null || remaining === undefined) {
          // Paiement bien reçu, mais plus aucune place au moment de la
          // confirmation (cas rare : deux paiements simultanés sur la
          // dernière place). On NE marque PAS "confirme" automatiquement :
          // l'équipe MYU doit trancher (honorer quand même ou rembourser).
          nextStatut = "demande";
          console.error(
            `[sumup-webhook] ⚠️ acompte payé (rdv ${rdv.id}, cliente ${rdv.client_id}) mais offre "${rdv.type_prestation}" complète — vérification manuelle requise.`
          );
          try {
            await admin.from("notes_internes").insert({
              client_id: rdv.client_id,
              note: `⚠️ Acompte MODÈLE MYU payé (rdv ${rdv.id}) mais plus de place disponible au moment de la confirmation. À vérifier avec la cliente (honorer la place ou rembourser via le tableau de bord SumUp).`,
            });
          } catch (noteErr) {
            console.error("[sumup-webhook] ajout note interne :", noteErr.message);
          }
        }
      }
    }

    const { error: updErr } = await admin
      .from("rendez_vous")
      .update({
        payment_status: "paye",
        payment_date: new Date().toISOString(),
        statut: nextStatut,
      })
      .eq("id", rdv.id);
    if (updErr) {
      console.error("[sumup-webhook] mise à jour rendez_vous (paye) :", updErr.message);
      res.status(500).json({ error: "Erreur serveur." });
      return;
    }
  } else if (status === "FAILED" || status === "EXPIRED") {
    const { error: updErr } = await admin
      .from("rendez_vous")
      .update({ payment_status: "echoue", statut: "annule" })
      .eq("id", rdv.id);
    if (updErr) {
      console.error("[sumup-webhook] mise à jour rendez_vous (echoue) :", updErr.message);
      res.status(500).json({ error: "Erreur serveur." });
      return;
    }
  }
  // status === "PENDING" (ou autre) : rien à faire, on attend la prochaine notification.

  res.status(200).json({ received: true });
};
