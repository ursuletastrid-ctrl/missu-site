// Catalogue public MYU by Miss'U — utilisé par landing.html et book.html.
//
// Source de vérité pour les LIBELLÉS, CATÉGORIES et TARIFS AFFICHÉS (prix
// plein). Recopié depuis le tableau SERVICES de index.html (zone "ZONE
// TARIFS" en tête de fichier) : si Astrid change un tarif dans index.html,
// pense à reporter le changement ici pour éviter tout écart entre "Mon
// Espace MYU" et le site public. Le montant d'ACOMPTE, lui, ne vient jamais
// d'ici : il est relu en direct depuis Supabase (table prestations_reservation)
// via /api/public-booking, seule source de vérité pour l'argent réellement
// dû en ligne.
window.MYU_CATALOG = [
  { key: "candy_lips", label: "Candy Lips", category: "levres", price: 200, desc: "Effet dégradé ombré, couleur lèvres rosée et lumineuse." },
  { key: "powder_brows", label: "Powder Brows", category: "regard", price: 300, desc: "Sourcils à l'effet poudré, personnalisés selon votre morphologie." },
  { key: "velvet_lips", label: "Velvet Lips", category: "levres", price: 300, desc: "Blush lèvres uniforme, couleur homogène du contour au centre." },
  { key: "aqualips_blush", label: "AquaLips Blush", category: "levres", price: 180, desc: "Blush lèvres très léger, effet naturel à peine coloré." },
  { key: "neutralisation", label: "Neutralisation lèvres foncées", category: "levres", price: 250, desc: "Rééquilibre les tons foncés pour une couleur homogène." },
  { key: "eyeliner_classique", label: "Eyeliner classique", category: "regard", price: 200, desc: "Un trait fin et précis qui souligne le regard." },
  { key: "eyeliner_poudre", label: "Eyeliner poudré", category: "regard", price: 300, desc: "Effet doux et estompé pour un regard intense en douceur." },
  { key: "taches_brunes_visage", label: "Correction taches brunes · visage", category: "soins", price: 150, desc: "Atténue les taches pigmentaires du visage." },
  { key: "taches_brunes_corps", label: "Correction taches brunes · corps", category: "soins", price: 150, priceFrom: true, desc: "Atténue les taches pigmentaires du corps, zone par zone." },
  { key: "vergetures", label: "Correction vergetures", category: "soins", price: 100, priceFrom: true, desc: "Camouflage pigmentaire adapté à vos vergetures." },
  { key: "microneedling", label: "Microneedling", category: "soins", price: 150, desc: "Stimule le renouvellement cellulaire, resserre les pores." },
  { key: "bb_glow", label: "BB Glow", category: "soins", price: 200, desc: "Effet bonne mine progressif, teint plus lumineux." },
  { key: "soins_corps_infrarouge", label: "Soins corps infrarouge", category: "soins", price: 45, priceFrom: true, desc: "Chaleur infrarouge, stimule la circulation." },
  { key: "modele_myu", label: "Offre modèle MYU", category: "offre", price: 160, desc: "Tarif spécial modèle MYU — places limitées." },
];

window.MYU_CATEGORY_LABELS = { levres: "Lèvres", regard: "Regard", soins: "Soins", offre: "Offre limitée" };

window.myuFindService = function (key) {
  return (window.MYU_CATALOG || []).find((s) => s.key === key) || null;
};

window.myuFormatPrice = function (service) {
  if (!service || service.price == null) return "Sur devis";
  return (service.priceFrom ? "À partir de " : "") + service.price + " €";
};
