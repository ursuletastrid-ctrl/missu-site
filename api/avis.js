// /api/avis — avis clientes MYU.
// GET  : avis publiés (validés par Astrid), les plus récents d'abord.
// POST : { prenom, prestation, note, commentaire, publicationOk, contact, website }
//        → enregistré « en_attente ». Rien n'est publié sans validation
//          (actions avisList / avisModerate de /api/admin-myu).
const { getAdminClient } = require("./_supabaseAdmin");
const B = require("./_booking");

const PRESTATIONS = [
  "Neutralisation des lèvres", "Candy Lips", "Velvet Lips", "AquaLips Blush", "Hydralips",
  "Powder Brows", "Reconstruction des sourcils", "Eyeliner", "Freckles",
  "Tricopigmentation (SMP)", "Camouflage cicatrices / vergetures", "DermaGlow (soin visage)", "Autre",
];

module.exports = async function handler(req, res) {
  let admin;
  try { admin = getAdminClient(); }
  catch (e) { return res.status(500).json({ error: e.message }); }

  if (req.method === "GET") {
    const { data, error } = await admin.from("avis")
      .select("prenom,prestation,note,commentaire,created_at")
      .eq("statut", "publie").order("created_at", { ascending: false }).limit(30);
    if (error) { console.error("[avis] GET :", error.message); return res.status(500).json({ error: "Avis indisponibles." }); }
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    return res.status(200).json({ success: true, data: data || [] });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée." });

  const body = B.requestBody(req);
  if (body.website) return res.status(200).json({ success: true }); // pot de miel anti-robots
  const prenom = B.clean(body.prenom, 40);
  const prestation = PRESTATIONS.includes(body.prestation) ? body.prestation : "Autre";
  const note = Math.round(Number(body.note));
  const commentaire = String(body.commentaire || "").replace(/\s+\n/g, "\n").trim().slice(0, 1200);
  const contact = B.clean(body.contact, 80);
  if (!prenom) return res.status(400).json({ error: "Indiquez votre prénom." });
  if (!(note >= 1 && note <= 5)) return res.status(400).json({ error: "Choisissez une note de 1 à 5 étoiles." });
  if (commentaire.length < 10) return res.status(400).json({ error: "Votre commentaire est un peu court." });

  const { error } = await admin.from("avis").insert({
    prenom, prestation, note, commentaire, contact: contact || null, publication_ok: body.publicationOk === true,
  });
  if (error) { console.error("[avis] POST :", error.message); return res.status(500).json({ error: "Envoi impossible pour le moment." }); }
  // Trace lisible dans les logs Vercel (sans coordonnées) : permet de repérer
  // un nouvel avis et de préparer sa publication Instagram.
  console.log("[avis] nouveau " + JSON.stringify({ prenom, prestation, note, publicationOk: body.publicationOk === true, commentaire }));
  return res.status(200).json({ success: true });
};
