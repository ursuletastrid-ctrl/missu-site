// POST /api/invite-client
// Réservé à l'équipe MYU (vérifié via la table admins). Sert à la future migration
// des clientes déjà connues avant "Mon Espace MYU" : plutôt que de leur générer un
// mot de passe, on leur envoie un email sécurisé qui leur permet de choisir
// elles-mêmes leur mot de passe et d'activer leur compte.
//
// Corps attendu : { email, firstName?, lastName?, phone?, city? }
//
// Utilise l'API d'administration Supabase (clé service_role) — inviteUserByEmail
// n'est pas disponible avec la clé publique "anon" et ne doit jamais l'être.
// Non branché à aucune interface pour l'instant : à utiliser depuis l'interface
// admin une fois la migration décidée, prestation par prestation, cliente par
// cliente — jamais en masse sans validation.

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

  let callerIsAdmin = false;
  try {
    callerIsAdmin = await isAdminUser(admin, caller.id);
  } catch (e) {
    res.status(500).json({ error: "Erreur de vérification des droits." });
    return;
  }
  if (!callerIsAdmin) {
    res.status(403).json({ error: "Action réservée à l'équipe MYU." });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body || "{}"); } catch { body = {}; }
  }
  body = body || {};

  const email = (body.email || "").trim();
  if (!email) {
    res.status(400).json({ error: "Email requis." });
    return;
  }

  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
    data: {
      first_name: body.firstName || "",
      last_name: body.lastName || "",
      phone: body.phone || "",
      city: body.city || "",
    },
  });

  if (error) {
    console.error(`[invite-client] échec invitation ${email} par ${caller.id} :`, error.message);
    res.status(500).json({ error: error.message || "L'invitation a échoué." });
    return;
  }

  console.log(`[invite-client] invitation envoyée à ${email} par ${caller.id} le ${new Date().toISOString()}`);
  res.status(200).json({ success: true, userId: data?.user?.id || null });
};
