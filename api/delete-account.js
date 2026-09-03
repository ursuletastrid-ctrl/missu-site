// POST /api/delete-account
// Suppression définitive d'un compte "Mon Espace MYU" (droit à l'effacement RGPD).
//
// Une cliente connectée peut supprimer SON PROPRE compte (aucun autre champ requis).
// Un membre de l'équipe (présent dans la table admins) peut supprimer le compte
// d'une autre cliente en envoyant { targetUserId } dans le corps de la requête.
//
// La suppression passe par l'API d'administration Supabase (clé service_role,
// jamais exposée au navigateur) et supprime la ligne dans auth.users ; toutes les
// tables liées (profiles, prestations_client, etapes_parcours, suivi_cicatrisation,
// fidelite, parrainages, avantages, rendez_vous, documents_consentements,
// notes_internes) sont nettoyées automatiquement par les contraintes
// "on delete cascade" définies dans le schéma — un seul appel suffit.
//
// Sécurité : le jeton envoyé par le navigateur est vérifié côté serveur avant
// toute action (voir _supabaseAdmin.js) — jamais de suppression sur simple
// déclaration d'identité non vérifiée.

const { getAdminClient, getCallerFromRequest, isAdminUser } = require("./_supabaseAdmin");

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

  const targetUserId = body.targetUserId || caller.id;

  if (targetUserId !== caller.id) {
    let callerIsAdmin = false;
    try {
      callerIsAdmin = await isAdminUser(admin, caller.id);
    } catch (e) {
      res.status(500).json({ error: "Erreur de vérification des droits." });
      return;
    }
    if (!callerIsAdmin) {
      res.status(403).json({ error: "Vous n'avez pas les droits pour supprimer ce compte." });
      return;
    }
  }

  const { error: deleteError } = await admin.auth.admin.deleteUser(targetUserId);
  if (deleteError) {
    console.error(`[delete-account] échec suppression ${targetUserId} demandée par ${caller.id} :`, deleteError.message);
    res.status(500).json({ error: "La suppression a échoué. Merci de réessayer ou de contacter le support." });
    return;
  }

  console.log(`[delete-account] compte ${targetUserId} supprimé (demandé par ${caller.id}) le ${new Date().toISOString()}`);
  res.status(200).json({ success: true });
};
