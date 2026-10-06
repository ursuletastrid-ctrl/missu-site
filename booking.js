// /api/booking — point d'entrée public de la réservation par créneaux.
//
//   GET  ?action=availability&service=<clé>&lieu=<lieu>&from=YYYY-MM-DD&days=14
//        -> créneaux réellement libres (horaires d'Astrid, plages bloquées de
//           l'application, événements occupés de son agenda, durée de la prestation)
//   GET  ?action=status&id=<rdv>
//        -> état d'une réservation (rapproché de SumUp si le paiement est en attente)
//   GET  ?action=status&id=<rdv>&scope=sync
//        -> même chose + coordonnées, utilisé par l'Apps Script pour écrire
//           l'événement d'agenda et la ligne de la feuille à partir des données serveur
//   POST ?action=release   { id }
//        -> la cliente renonce : le créneau est libéré SEULEMENT si SumUp confirme
//           qu'aucun paiement n'a abouti (le checkout est désactivé avant)
//   GET|POST ?action=maintenance
//        -> libère les maintiens expirés (après vérification SumUp) et retente les
//           synchronisations agenda/feuille en échec. Idempotent, sans donnée renvoyée.
//
// L'identifiant de réservation (UUID aléatoire) sert de clé d'accès : il n'est
// connu que de la cliente (lien de retour du paiement) et de l'équipe MYU.

const { getAdminClient } = require("./_supabaseAdmin");
const B = require("./_booking");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function availability(admin, q) {
  const typePrestation = B.clean(q.service, 80);
  const settings = await B.loadSettings(admin);
  const lieu = B.clean(q.lieu, 80) || settings.lieux[0];
  if (!typePrestation) throw B.httpError(400, "Prestation requise.");
  await B.releaseExpiredHolds(admin, { limit: 5 }).catch((e) => console.error("[booking] maintiens expirés :", e.message));
  const prestation = await B.loadPrestation(admin, typePrestation);
  const places = await B.remainingLimitedPlaces(admin, prestation);
  const slots = await B.computeSlots(admin, {
    typePrestation, lieu, from: B.clean(q.from, 10), days: Number(q.days) || 14, settings, prestation,
  });
  // Rattrapage opportuniste d'une synchronisation en échec (borné à 1, sans bloquer la réponse en cas d'erreur).
  await B.retryPendingSyncs(admin, { limit: 1, minDelayMs: 5 * 60000 }).catch(() => {});
  return {
    prestation: B.serviceLabel(typePrestation),
    lieux: settings.lieux,
    lieu,
    dureeMinutes: slots.dureeMinutes,
    acompte: prestation.deposit_amount,
    placesRestantes: places,
    maintienMinutes: settings.maintien_minutes,
    fuseau: B.TZ,
    jours: slots.jours,
  };
}

async function status(admin, q) {
  const id = B.clean(q.id, 40);
  if (!UUID_RE.test(id)) throw B.httpError(400, "Référence invalide.");
  let rdv = await B.getRdv(admin, id);
  if (!rdv) throw B.httpError(404, "Réservation introuvable.");
  const scope = q.scope === "sync" ? "sync" : null;
  if (!scope && rdv.statut === "en_attente_paiement" && rdv.payment_reference) {
    try {
      const r = await B.reconcilePayment(admin, rdv);
      rdv = r.rdv || rdv;
    } catch (e) {
      console.error("[booking] rapprochement statut :", e.message);
    }
  }
  const profile = await B.loadProfile(admin, rdv.client_id);
  return B.bookingView(rdv, { profile, scope });
}

async function release(admin, body) {
  const id = B.clean(body.id, 40);
  if (!UUID_RE.test(id)) throw B.httpError(400, "Référence invalide.");
  const rdv = await B.getRdv(admin, id);
  if (!rdv) throw B.httpError(404, "Réservation introuvable.");
  const r = await B.releaseHoldSafely(admin, rdv, "Paiement abandonné par la cliente (vérifié chez SumUp)");
  const fresh = await B.getRdv(admin, id);
  const profile = await B.loadProfile(admin, fresh.client_id);
  return { resultat: r.etat, reservation: B.bookingView(fresh, { profile }) };
}

async function maintenance(admin) {
  const holds = await B.releaseExpiredHolds(admin, { limit: 20 });
  const syncs = await B.retryPendingSyncs(admin, { limit: 10, minDelayMs: 60000 });
  return { maintiens: holds, synchronisations: syncs };
}

module.exports = async function handler(req, res) {
  const q = req.query || {};
  // Le cron Vercel (quotidien) appelle /api/booking sans paramètre : maintenance.
  const action = q.action || (String(req.headers["user-agent"] || "").includes("vercel-cron") ? "maintenance" : "");
  let admin;
  try { admin = getAdminClient(); }
  catch (e) { return res.status(500).json({ error: e.message }); }

  try {
    let data;
    if (action === "availability" && req.method === "GET") data = await availability(admin, q);
    else if (action === "status" && req.method === "GET") data = await status(admin, q);
    else if (action === "release" && req.method === "POST") data = await release(admin, B.requestBody(req));
    else if (action === "maintenance") data = await maintenance(admin);
    else return res.status(400).json({ error: "Action inconnue." });
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ success: true, data });
  } catch (e) {
    if (!e.status || e.status >= 500) console.error(`[booking] ${action} :`, e.message);
    return res.status(e.status || 500).json({ error: e.status && e.status < 500 ? e.message : (e.status === 503 ? "Les disponibilités ne peuvent pas être vérifiées pour le moment (agenda injoignable). Merci de réessayer dans quelques minutes." : "Service momentanément indisponible. Merci de réessayer.") });
  }
};
