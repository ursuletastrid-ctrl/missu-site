// /api/public-booking — réservation sans compte (book.html).
//
// GET  : catalogue des prestations réservables (acompte, places, durée, lieux).
// POST : { typePrestation, lieu, dateRdv, heureRdv, firstName, lastName, phone, email, consent }
//        1. vérifie TOUT côté serveur (prestation active, lieu proposé, créneau
//           réellement libre : horaires, plages bloquées, agenda d'Astrid) ;
//        2. enregistre la cliente (profil) et la réservation avec ses
//           coordonnées, le créneau étant maintenu (bloqué) pendant le paiement ;
//        3. seulement ensuite, ouvre le paiement SumUp de l'acompte
//           (checkout valable jusqu'à l'expiration du maintien).
// Aucun paiement ne peut être lancé sans prestation + lieu + jour + horaire valides.

const { getAdminClient } = require("./_supabaseAdmin");
const B = require("./_booking");

function referralCode(firstName) {
  const base = B.clean(firstName, 10).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z]/g, "") || "MYU";
  return `MYU-${base}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

module.exports = async function handler(req, res) {
  let admin;
  try { admin = getAdminClient(); }
  catch (e) { return res.status(500).json({ error: e.message }); }

  if (req.method === "GET") {
    try {
      const settings = await B.loadSettings(admin);
      const { data, error } = await admin.from("prestations_reservation")
        .select("type_prestation,deposit_amount,is_limited_offer,available_slots,active,duree_minutes").eq("active", true);
      if (error) throw error;
      return res.status(200).json({ success: true, data: data || [], lieux: settings.lieux });
    } catch (e) {
      console.error("[public-booking] lecture catalogue :", e.message);
      return res.status(500).json({ error: "Réservations momentanément indisponibles." });
    }
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée." });

  const body = B.requestBody(req);
  const firstName = B.clean(body.firstName, 60);
  const lastName = B.clean(body.lastName, 60);
  const phone = B.clean(body.phone, 30);
  const contactEmail = B.clean(body.email, 160).toLowerCase();
  const input = {
    typePrestation: B.clean(body.typePrestation, 80),
    lieu: B.clean(body.lieu, 80),
    dateRdv: B.clean(body.dateRdv, 10),
    heureRdv: B.clean(body.heureRdv, 5),
  };

  if (!firstName || !phone) return res.status(400).json({ error: "Prénom et téléphone sont requis." });
  if (!/^[+\d][\d\s.-]{5,}$/.test(phone)) return res.status(400).json({ error: "Numéro de téléphone invalide." });
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) return res.status(400).json({ error: "Email invalide." });
  if (body.consent !== true) return res.status(400).json({ error: "Votre accord est requis pour transmettre la demande et organiser le rendez-vous." });

  let guestId = null;
  let rdv = null;
  try {
    // 1. Vérification complète du créneau AVANT toute création.
    const { settings, prestation } = await B.assertSlotBookable(admin, input);

    // 2. Cliente + réservation (créneau maintenu) avec ses coordonnées.
    const guestEmail = `booking-${Date.now()}-${Math.random().toString(36).slice(2, 9)}@guest.myu.local`;
    const password = `${Math.random().toString(36).slice(2)}A!9${Date.now()}`;
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

    rdv = await B.createHold(admin, { clientId: guestId, input, contactEmail, settings, prestation });

    // 3. Paiement (ou confirmation directe si aucun acompte n'est prévu).
    if (prestation.deposit_amount <= 0) {
      await B.syncBookingExternal(admin, rdv.id).catch((e) => console.error("[public-booking] synchro :", e.message));
      return res.status(200).json({ success: true, data: { rdvId: rdv.id, checkoutUrl: null } });
    }
    const checkoutUrl = await B.startPayment(admin, rdv, {
      redirectUrl: `${B.SITE_ORIGIN}/book.html?rdv=${encodeURIComponent(rdv.id)}&paid=1`,
    });
    return res.status(200).json({ success: true, data: { rdvId: rdv.id, checkoutUrl, maintienExpireLe: rdv.maintien_expire_le } });
  } catch (e) {
    if (guestId && !rdv) {
      // Aucune réservation créée : on ne garde pas de fiche cliente orpheline.
      await admin.auth.admin.deleteUser(guestId).catch(() => {});
    }
    const status = e.status || 500;
    if (status >= 500) console.error("[public-booking]", e?.message || e);
    const message = status === 503
      ? "Les disponibilités ne peuvent pas être vérifiées pour le moment. Merci de réessayer dans quelques minutes."
      : status < 500 || status === 502 ? e.message : "La réservation n'a pas pu être finalisée. Réessayez ou contactez MYU.";
    return res.status(status).json({ error: message });
  }
};
