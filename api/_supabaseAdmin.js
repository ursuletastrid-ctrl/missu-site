// Aide partagée par les fonctions serverless de /api.
// Fichier préfixé par "_" : Vercel ne le transforme pas en route, seules
// les fonctions qui l'importent (delete-account.js, invite-client.js...)
// sont exposées comme endpoints.
//
// La clé service_role n'est JAMAIS écrite dans ce dépôt : elle est lue
// uniquement depuis la variable d'environnement Vercel SUPABASE_SERVICE_ROLE_KEY,
// à ajouter dans Project Settings → Environment Variables sur vercel.com.
// Sans cette variable, ces fonctions répondent une erreur claire au lieu
// de planter silencieusement.

const { createClient } = require("@supabase/supabase-js");

// L'URL du projet n'est pas un secret (elle est déjà visible dans index.html
// côté navigateur) : elle peut rester en dur ici pour simplifier la configuration.
const SUPABASE_URL = "https://blfsbzwwsqixlzxobavh.supabase.co";

function getAdminClient() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY manquante dans les variables d'environnement Vercel."
    );
  }
  return createClient(SUPABASE_URL, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Vérifie le jeton d'accès envoyé par le navigateur (header Authorization: Bearer <token>)
// et renvoie l'utilisateur Supabase correspondant. Ceci est la seule façon sûre de savoir
// "qui appelle vraiment" côté serveur — jamais faire confiance à un id envoyé dans le corps
// de la requête sans le vérifier.
async function getCallerFromRequest(req, adminClient) {
  const authHeader = req.headers["authorization"] || req.headers["Authorization"];
  const token = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return null;
  const { data, error } = await adminClient.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

async function isAdminUser(adminClient, userId) {
  const { data, error } = await adminClient
    .from("admins")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

module.exports = { getAdminClient, getCallerFromRequest, isAdminUser, SUPABASE_URL };
