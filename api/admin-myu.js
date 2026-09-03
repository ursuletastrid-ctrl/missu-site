// POST /api/admin-myu
// Dispatcher unique pour toutes les actions d'administration de "Mon Espace MYU"
// (recherche cliente, fiche cliente, validation tampon/parrainage, consignes,
// notes internes, prestations, parcours, rendez-vous).
//
// Autorisation : vérifie que `adminToken` correspond à la variable d'environnement
// Vercel MYU_ADMIN_TOKEN — le même principe que le code déjà utilisé pour "Espace
// Miss'U (admin)" côté Google Sheets, pour ne pas ajouter un second système de
// connexion. Une fois vérifié, la fonction utilise la clé service_role pour agir
// sur Supabase : c'est la SEULE façon d'accéder à la table notes_internes (aucune
// policy RLS ne l'autorise, même pour un compte admin authentifié) et la façon la
// plus simple d'appliquer les autres écritures réservées à l'équipe MYU.
//
// Corps attendu : { adminToken, action, payload }

const { getAdminClient } = require("./_supabaseAdmin");

const PRESTATION_STATUTS = ["a_venir", "realisee", "en_cicatrisation", "suivi_necessaire", "retouche_a_prevoir", "terminee"];
const RDV_STATUTS = ["demande", "en_attente_paiement", "confirme", "modifie", "annule", "terminee"];
const PAYMENT_STATUTS = ["non_requis", "en_attente", "paye", "echoue", "rembourse"];

function requireAdminToken(body) {
  const expected = process.env.MYU_ADMIN_TOKEN;
  if (!expected) {
    throw Object.assign(new Error("MYU_ADMIN_TOKEN manquant dans les variables d'environnement Vercel."), { status: 500 });
  }
  if (!body || body.adminToken !== expected) {
    throw Object.assign(new Error("Code administrateur invalide."), { status: 401 });
  }
}

async function searchClients(admin, { query }) {
  const q = (query || "").trim();
  if (!q) return [];
  const { data: profiles, error } = await admin
    .from("profiles")
    .select("id, first_name, last_name, phone, city, referral_code")
    .or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,phone.ilike.%${q}%,city.ilike.%${q}%`)
    .limit(25);
  if (error) throw error;

  let results = profiles || [];

  // Recherche complémentaire par email si la requête y ressemble et qu'aucun
  // profil n'a déjà été trouvé par nom/téléphone/ville.
  if (results.length === 0 && q.includes("@")) {
    const { data: page, error: listErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    if (!listErr && page?.users) {
      const matches = page.users.filter((u) => (u.email || "").toLowerCase().includes(q.toLowerCase()));
      if (matches.length) {
        const ids = matches.map((u) => u.id);
        const { data: matchedProfiles } = await admin.from("profiles").select("id, first_name, last_name, phone, city, referral_code").in("id", ids);
        results = (matchedProfiles || []).map((p) => ({ ...p, email: matches.find((u) => u.id === p.id)?.email || "" }));
      }
    }
  }
  return results;
}

async function getClient(admin, { clientId }) {
  if (!clientId) throw Object.assign(new Error("clientId requis."), { status: 400 });
  const [{ data: profile }, { data: authUser }, { data: prestations }, { data: fidelite }, { data: parrainages }, { data: avantages }, { data: rendezVous }, { data: documents }, { data: notes }] = await Promise.all([
    admin.from("profiles").select("*").eq("id", clientId).maybeSingle(),
    admin.auth.admin.getUserById(clientId),
    admin.from("prestations_client").select("*").eq("client_id", clientId).order("date_prestation", { ascending: false }),
    admin.from("fidelite").select("*").eq("client_id", clientId).maybeSingle(),
    admin.from("parrainages").select("*").eq("parrain_id", clientId).order("created_at", { ascending: false }),
    admin.from("avantages").select("*").eq("client_id", clientId).order("date_deblocage", { ascending: false }),
    admin.from("rendez_vous").select("*").eq("client_id", clientId).order("date_rdv", { ascending: false }),
    admin.from("documents_consentements").select("*").eq("client_id", clientId).order("accepte_le", { ascending: false }),
    admin.from("notes_internes").select("*").eq("client_id", clientId).order("created_at", { ascending: false }),
  ]);

  const prestationIds = (prestations || []).map((p) => p.id);
  let etapes = [];
  if (prestationIds.length) {
    const { data } = await admin.from("etapes_parcours").select("*").in("prestation_id", prestationIds).order("ordre", { ascending: true });
    etapes = data || [];
  }

  return {
    profile: profile || null,
    email: authUser?.user?.email || null,
    prestations: prestations || [],
    etapes,
    fidelite: fidelite || { client_id: clientId, tampons: 0 },
    parrainages: parrainages || [],
    avantages: avantages || [],
    rendezVous: rendezVous || [],
    documents: documents || [],
    notes: notes || [],
  };
}

async function addTampon(admin, { clientId }) {
  if (!clientId) throw Object.assign(new Error("clientId requis."), { status: 400 });
  const { data: current } = await admin.from("fidelite").select("tampons").eq("client_id", clientId).maybeSingle();
  const next = Math.min(3, (current?.tampons || 0) + 1);
  const { data, error } = await admin
    .from("fidelite")
    .upsert({ client_id: clientId, tampons: next, updated_at: new Date().toISOString() })
    .select().single();
  if (error) throw error;
  return data;
}

async function resetTampons(admin, { clientId }) {
  if (!clientId) throw Object.assign(new Error("clientId requis."), { status: 400 });
  const { data, error } = await admin
    .from("fidelite")
    .upsert({ client_id: clientId, tampons: 0, updated_at: new Date().toISOString() })
    .select().single();
  if (error) throw error;
  return data;
}

async function validateParrainage(admin, { parrainageId }) {
  if (!parrainageId) throw Object.assign(new Error("parrainageId requis."), { status: 400 });
  const { data: parrainage, error: getErr } = await admin.from("parrainages").select("*").eq("id", parrainageId).maybeSingle();
  if (getErr) throw getErr;
  if (!parrainage) throw Object.assign(new Error("Recommandation introuvable."), { status: 404 });
  if (parrainage.statut === "validee") return parrainage;

  const { data: updated, error: updErr } = await admin
    .from("parrainages")
    .update({ statut: "validee", date_validation: new Date().toISOString() })
    .eq("id", parrainageId)
    .select().single();
  if (updErr) throw updErr;

  const { error: avErr } = await admin.from("avantages").insert({
    client_id: parrainage.parrain_id,
    type_avantage: "Recommandation validée",
    description: "-100€ sur une prestation Lèvres éligible",
    statut: "disponible",
  });
  if (avErr) throw avErr;

  return updated;
}

async function markAvantageUsed(admin, { avantageId }) {
  if (!avantageId) throw Object.assign(new Error("avantageId requis."), { status: 400 });
  const { data, error } = await admin
    .from("avantages")
    .update({ statut: "utilise", date_utilisation: new Date().toISOString() })
    .eq("id", avantageId)
    .select().single();
  if (error) throw error;
  return data;
}

async function listConsignes(admin) {
  const { data, error } = await admin.from("consignes_prestations").select("*");
  if (error) throw error;
  return data || [];
}

async function upsertConsigne(admin, { typePrestation, titre, contenu }) {
  if (!typePrestation) throw Object.assign(new Error("typePrestation requis."), { status: 400 });
  const { data, error } = await admin
    .from("consignes_prestations")
    .upsert({ type_prestation: typePrestation, titre: titre || null, contenu: contenu || null, updated_at: new Date().toISOString() })
    .select().single();
  if (error) throw error;
  return data;
}

async function addNoteInterne(admin, { clientId, note }) {
  if (!clientId || !note || !note.trim()) throw Object.assign(new Error("clientId et note requis."), { status: 400 });
  const { data, error } = await admin
    .from("notes_internes")
    .insert({ client_id: clientId, note: note.trim() })
    .select().single();
  if (error) throw error;
  return data;
}

async function createPrestation(admin, { clientId, typePrestation, datePrestation, numeroSeance }) {
  if (!clientId || !typePrestation) throw Object.assign(new Error("clientId et typePrestation requis."), { status: 400 });
  const { data, error } = await admin
    .from("prestations_client")
    .insert({
      client_id: clientId, type_prestation: typePrestation,
      date_prestation: datePrestation || null, numero_seance: numeroSeance || 1,
    })
    .select().single();
  if (error) throw error;
  return data;
}

async function updatePrestationStatus(admin, { prestationId, statut, prochaineEtape, retouchePrevueLe }) {
  if (!prestationId || !statut) throw Object.assign(new Error("prestationId et statut requis."), { status: 400 });
  if (!PRESTATION_STATUTS.includes(statut)) throw Object.assign(new Error("Statut de prestation invalide."), { status: 400 });
  const patch = { statut, updated_at: new Date().toISOString() };
  if (prochaineEtape !== undefined) patch.prochaine_etape = prochaineEtape || null;
  if (retouchePrevueLe !== undefined) patch.retouche_prevue_le = retouchePrevueLe || null;
  const { data, error } = await admin.from("prestations_client").update(patch).eq("id", prestationId).select().single();
  if (error) throw error;
  return data;
}

async function upsertEtapeParcours(admin, { etapeId, prestationId, etape, ordre, franchie, dateFranchie }) {
  if (etapeId) {
    const patch = {};
    if (etape !== undefined) patch.etape = etape;
    if (ordre !== undefined) patch.ordre = ordre;
    if (franchie !== undefined) patch.franchie = franchie;
    if (dateFranchie !== undefined) patch.date_franchie = dateFranchie || null;
    const { data, error } = await admin.from("etapes_parcours").update(patch).eq("id", etapeId).select().single();
    if (error) throw error;
    return data;
  }
  if (!prestationId || !etape) throw Object.assign(new Error("prestationId et etape requis."), { status: 400 });
  const { data, error } = await admin
    .from("etapes_parcours")
    .insert({ prestation_id: prestationId, etape, ordre: ordre || 0, franchie: !!franchie, date_franchie: dateFranchie || null })
    .select().single();
  if (error) throw error;
  return data;
}

// releaseSlot : quand on passe explicitement statut="annule" sur un rendez-vous
// dont l'acompte était payé (place déjà décomptée), l'admin peut cocher la
// libération de la place dans le même geste — sinon la place reste bloquée
// même après annulation. Jamais automatique : c'est un choix de l'équipe MYU
// (ex. annulation tardive où la place n'est pas remise en vente).
async function updateRendezVous(admin, { rdvId, statut, dateRdv, heureRdv, paymentStatus, releaseSlot }) {
  if (!rdvId) throw Object.assign(new Error("rdvId requis."), { status: 400 });
  if (statut && !RDV_STATUTS.includes(statut)) throw Object.assign(new Error("Statut de rendez-vous invalide."), { status: 400 });
  if (paymentStatus && !PAYMENT_STATUTS.includes(paymentStatus)) throw Object.assign(new Error("Statut de paiement invalide."), { status: 400 });

  const patch = {};
  if (statut !== undefined) patch.statut = statut;
  if (dateRdv !== undefined) patch.date_rdv = dateRdv || null;
  if (heureRdv !== undefined) patch.heure_rdv = heureRdv || null;
  if (paymentStatus !== undefined) patch.payment_status = paymentStatus;

  const { data, error } = await admin.from("rendez_vous").update(patch).eq("id", rdvId).select().single();
  if (error) throw error;

  if (releaseSlot && statut === "annule" && data?.type_prestation) {
    const { data: reservation } = await admin
      .from("prestations_reservation")
      .select("is_limited_offer")
      .eq("type_prestation", data.type_prestation)
      .maybeSingle();
    if (reservation?.is_limited_offer) {
      await admin.rpc("release_modele_slot", { p_type_prestation: data.type_prestation });
    }
  }

  return data;
}

// ------------------------------------------------------------
// Offres limitées / acomptes ("MODÈLE MYU" et, plus largement,
// prestations_reservation) — même table que celle lue par le site public
// pour le montant de l'acompte et les places restantes ; ici l'équipe MYU
// peut la consulter et l'éditer (aucun doublon de données).
// ------------------------------------------------------------

async function listPrestationsReservation(admin) {
  const { data, error } = await admin.from("prestations_reservation").select("*").order("type_prestation", { ascending: true });
  if (error) throw error;
  return data || [];
}

async function upsertPrestationReservation(admin, { typePrestation, depositAmount, active, totalSlots, availableSlots }) {
  if (!typePrestation) throw Object.assign(new Error("typePrestation requis."), { status: 400 });
  const patch = { type_prestation: typePrestation, updated_at: new Date().toISOString() };
  if (depositAmount !== undefined) patch.deposit_amount = depositAmount;
  if (active !== undefined) patch.active = active;
  if (totalSlots !== undefined) patch.total_slots = totalSlots;
  if (availableSlots !== undefined) patch.available_slots = availableSlots;
  const { data, error } = await admin.from("prestations_reservation").upsert(patch).select().single();
  if (error) throw error;
  return data;
}

// Libère une place manuellement (indépendamment de l'annulation d'un
// rendez-vous précis) — ex. correction d'un décompte, place libérée pour une
// autre raison que le flux normal d'annulation ci-dessus.
async function releaseModeleSlot(admin, { typePrestation }) {
  if (!typePrestation) throw Object.assign(new Error("typePrestation requis."), { status: 400 });
  const { data, error } = await admin.rpc("release_modele_slot", { p_type_prestation: typePrestation });
  if (error) throw error;
  return { typePrestation, availableSlots: data };
}

// Liste, pour une offre limitée donnée (par défaut "modele_myu"), toutes les
// réservations avec le nom de la cliente — vue admin dédiée demandée pour
// suivre qui a réservé, le paiement, et pouvoir agir (annuler + libérer).
async function listModeleBookings(admin, { typePrestation }) {
  const type = typePrestation || "modele_myu";
  const { data: rdvs, error } = await admin
    .from("rendez_vous")
    .select("*")
    .eq("type_prestation", type)
    .order("created_at", { ascending: false });
  if (error) throw error;
  const clientIds = [...new Set((rdvs || []).map((r) => r.client_id))];
  let profiles = [];
  if (clientIds.length) {
    const { data } = await admin.from("profiles").select("id, first_name, last_name, phone").in("id", clientIds);
    profiles = data || [];
  }
  const byId = Object.fromEntries(profiles.map((p) => [p.id, p]));
  return (rdvs || []).map((r) => ({ ...r, client: byId[r.client_id] || null }));
}

const ACTIONS = {
  searchClients, getClient, addTampon, resetTampons, validateParrainage, markAvantageUsed,
  listConsignes, upsertConsigne, addNoteInterne, createPrestation, updatePrestationStatus, upsertEtapeParcours, updateRendezVous,
  listPrestationsReservation, upsertPrestationReservation, releaseModeleSlot, listModeleBookings,
};

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

  try {
    requireAdminToken(body);
  } catch (e) {
    res.status(e.status || 401).json({ error: e.message });
    return;
  }

  const fn = ACTIONS[body.action];
  if (!fn) {
    res.status(400).json({ error: "Action inconnue." });
    return;
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    res.status(500).json({ error: e.message });
    return;
  }

  try {
    const result = await fn(admin, body.payload || {});
    res.status(200).json({ success: true, data: result });
  } catch (e) {
    console.error(`[admin-myu] action "${body.action}" a échoué :`, e.message);
    res.status(e.status || 500).json({ error: e.message || "L'action a échoué." });
  }
};
