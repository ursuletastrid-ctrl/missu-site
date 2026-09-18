// /api/prediag-note.js
//
// Reçoit un court résumé du pré-diagnostic invité (rempli après paiement de
// l'acompte sur /prediag.html) et l'ajoute comme note interne rattachée à la
// cliente, visible immédiatement dans Mon Espace MYU (onglet admin), en plus
// de l'envoi complet (avec photos) vers le Google Sheet existant.
//
// Choix volontairement conservateur (brief : ne rien casser, pas de nouvelle
// table) : on réutilise telle quelle la table `notes_internes` déjà utilisée
// par l'admin MYU (voir api/admin-myu.js -> addNoteInterne), sans créer de
// nouvelle colonne ni de nouveau bucket. Endpoint accessible sans authentification
// admin (la cliente n'a pas de session admin) mais protégé par :
//  - vérification que `rdvId` correspond réellement à un rendez_vous existant,
//  - une longueur de note plafonnée,
//  - le même jeton anti-spam non-secret que le pipeline Sheets (SUBMIT_TOKEN),
// pour limiter les écritures aux appels provenant réellement du site.
const { getAdminClient } = require("./_supabaseAdmin");

const SUBMIT_TOKEN = "missu-prediag-2026-8f3kd91";

function clean(v, max = 4000) {
  return String(v || "").trim().slice(0, max);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée." });

  let admin;
  try { admin = getAdminClient(); }
  catch (e) { return res.status(500).json({ error: e.message }); }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body || "{}"); } catch { body = {}; } }
  body = body || {};

  if (clean(body.token, 100) !== SUBMIT_TOKEN) return res.status(403).json({ error: "Jeton invalide." });

  const rdvId = clean(body.rdvId, 100);
  const summary = clean(body.summary, 3000);
  if (!rdvId || !summary) return res.status(400).json({ error: "rdvId et summary sont requis." });

  try {
    const { data: rdv, error: rdvErr } = await admin
      .from("rendez_vous")
      .select("id,client_id")
      .eq("id", rdvId)
      .maybeSingle();
    if (rdvErr) throw rdvErr;
    if (!rdv) return res.status(404).json({ error: "Rendez-vous introuvable." });

    const { error: noteErr } = await admin.from("notes_internes").insert({
      client_id: rdv.client_id,
      note: summary,
    });
    if (noteErr) throw noteErr;

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error("[prediag-note]", e?.message || e);
    return res.status(500).json({ error: "La note n'a pas pu être enregistrée." });
  }
};
