const { getAdminClient } = require("./_supabaseAdmin");

function requestOrigin(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

function clean(v, max = 120) {
  return String(v || "").trim().slice(0, max);
}

function referralCode(firstName) {
  const base = clean(firstName, 10).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z]/g, "") || "MYU";
  return `MYU-${base}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

module.exports = async function handler(req, res) {
  let admin;
  try { admin = getAdminClient(); }
  catch (e) { return res.status(500).json({ error: e.message }); }

  if (req.method === "GET") {
    const { data, error } = await admin.from("prestations_reservation").select("type_prestation,deposit_amount,is_limited_offer,available_slots,active").eq("active", true);
        if (error) {
      console.error("[public-booking] lecture prestations_reservation :", error.message);
      return res.status(500).json({ error: "Réservations momentanément indisponibles." });
    }
    return res.status(200).json({ success: true, data: data || [] });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée." });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body || "{}"); } catch { body = {}; } }
  body = body || {};

  const firstName = clean(body.firstName, 60);
  const lastName = clean(body.lastName, 60);
  const phone = clean(body.phone, 30);
  const contactEmail = clean(body.email, 160).toLowerCase();
  const typePrestation = clean(body.typePrestation, 80);
  const dateRdv = clean(body.dateRdv, 10) || null;
  const heureRdv = clean(body.heureRdv, 5) || null;
  const consent = body.consent === true;

  if (!firstName || !phone || !typePrestation || !dateRdv || !heureRdv) return res.status(400).json({ error: "Prénom, téléphone, prestation, date et heure sont requis." });
  if (!consent) return res.status(400).json({ error: "Votre accord est requis pour transmettre la demande et organiser le rendez-vous." });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRdv) || !/^\d{2}:\d{2}$/.test(heureRdv)) return res.status(400).json({ error: "Créneau invalide." });

  const { data: reservation, error: resaErr } = await admin.from("prestations_reservation").select("*").eq("type_prestation", typePrestation).maybeSingle();
  if (resaErr || !reservation || !reservation.active) return res.status(400).json({ error: "Cette prestation n'est pas disponible à la réservation en ligne." });
  if (reservation.is_limited_offer && (reservation.available_slots ?? 0) <= 0) return res.status(409).json({ error: "Cette offre est complète." });

  const depositAmount = Number(reservation.deposit_amount) || 0;
  const guestEmail = `booking-${Date.now()}-${Math.random().toString(36).slice(2, 9)}@guest.myu.local`;
  const password = `${Math.random().toString(36).slice(2)}A!9${Date.now()}`;
  let guestId = null;

  try {
    const { data: authData, error: authErr } = await admin.auth.admin.createUser({
      email: guestEmail, password, email_confirm: true,
      user_metadata: { first_name: firstName, last_name: lastName, phone, contact_email: contactEmail, source: "public_booking" },
    });
    if (authErr || !authData?.user) throw authErr || new Error("Création cliente impossible");
    guestId = authData.user.id;

    const { error: profileErr } = await admin.from("profiles").upsert({
      id: guestId, first_name: firstName, last_name: lastName, phone, city: "", referral_code: referralCode(firstName),
    }, { onConflict: "id" });
    if (profileErr) throw profileErr;

    const { data: rdv, error: insertErr } = await admin.from("rendez_vous").insert({
      client_id: guestId,
      type_prestation: typePrestation,
      date_rdv: dateRdv,
      heure_rdv: heureRdv,
      statut: depositAmount > 0 ? "en_attente_paiement" : "demande",
      deposit_amount: depositAmount,
      payment_status: depositAmount > 0 ? "en_attente" : "non_requis",
    }).select().single();
    if (insertErr) {
      if (insertErr.code === "23505") return res.status(409).json({ error: "Ce créneau vient d'être réservé. Choisissez-en un autre." });
      throw insertErr;
    }

    if (depositAmount <= 0) return res.status(200).json({ success: true, data: { rdvId: rdv.id, checkoutUrl: null } });

    const sumupApiKey = process.env.SUMUP_API_KEY;
    const sumupMerchantCode = process.env.SUMUP_MERCHANT_CODE;
    if (!sumupApiKey || !sumupMerchantCode) throw new Error("Paiement en ligne momentanément indisponible.");

    const sumupRes = await fetch("https://api.sumup.com/v0.1/checkouts", {
      method: "POST",
      headers: { Authorization: `Bearer ${sumupApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        checkout_reference: rdv.id,
        amount: depositAmount,
        currency: "EUR",
        merchant_code: sumupMerchantCode,
        description: `Acompte réservation — ${typePrestation}`,
        redirect_url: `${requestOrigin(req)}/book.html?rdv=${encodeURIComponent(rdv.id)}&paid=1`,
        return_url: `${requestOrigin(req)}/api/sumup-webhook`,
        hosted_checkout: { enabled: true },
      }),
    });
    const checkout = await sumupRes.json().catch(() => ({}));
    if (!sumupRes.ok || !checkout?.id) throw new Error(checkout?.message || "Le paiement n'a pas pu être initié.");

    await admin.from("rendez_vous").update({ payment_reference: checkout.id }).eq("id", rdv.id);
    return res.status(200).json({ success: true, data: { rdvId: rdv.id, checkoutUrl: checkout.hosted_checkout_url || null } });
  } catch (e) {
    console.error("[public-booking]", e?.message || e);
    if (guestId) {
      // Ne supprime le profil invité que si aucun rendez-vous n'a survécu ; la suppression Auth cascade selon le schéma.
      const { data: rows } = await admin.from("rendez_vous").select("id").eq("client_id", guestId).limit(1);
      if (!rows?.length) await admin.auth.admin.deleteUser(guestId).catch(() => {});
    }
    return res.status(500).json({ error: "La réservation n'a pas pu être finalisée. Réessayez ou contactez MYU." });
  }
};
