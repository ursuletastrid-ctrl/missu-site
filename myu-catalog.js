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
  { key: "candy_lips", label: "Candy Lips", category: "levres", price: 200, desc: "Le dégradé qui donne du relief à votre sourire. Retouche incluse." },
  { key: "powder_brows", label: "Powder Brows", category: "regard", price: 300, desc: "Des sourcils dessinés pour vous, et des matins sans crayon. Retouche incluse." },
  { key: "reconstruction_sourcils", label: "Reconstruction des sourcils", category: "regard", price: 350, desc: "Camouflage ou restructuration d'un ancien maquillage permanent. 1 retouche comprise, retouches suivantes à 80 €." },
  { key: "velvet_lips", label: "Velvet Lips", category: "levres", price: 300, desc: "Blush lèvres uniforme, couleur homogène du contour au centre." },
  { key: "aqualips_blush", label: "AquaLips Blush", category: "levres", price: 180, desc: "Un blush très léger : la porte d'entrée idéale pour découvrir la couleur sur vos lèvres." },
  { key: "neutralisation", label: "Neutralisation lèvres foncées", category: "levres", price: 250, desc: "Atténue les tons foncés et unifie vos lèvres : la première étape du parcours Lèvres révélées. Diagnostic 30 € compris dans l'acompte, retouche incluse." },
  { key: "eyeliner_classique", label: "Eyeliner classique", category: "regard", price: 200, desc: "Un trait fin et précis qui souligne le regard." },
  { key: "eyeliner_poudre", label: "Eyeliner poudré", category: "regard", price: 300, desc: "Un regard intense dès le réveil, effet doux et estompé. Retouche incluse." },
  { key: "taches_brunes_visage", label: "Correction taches brunes · visage", category: "soins", price: 150, desc: "Atténue les taches pigmentaires du visage." },
  { key: "taches_brunes_corps", label: "Correction taches brunes · corps", category: "soins", price: 150, priceFrom: true, desc: "Atténue les taches pigmentaires du corps, zone par zone." },
  { key: "vergetures", label: "Correction vergetures", category: "soins", price: 100, priceFrom: true, desc: "Camouflage pigmentaire adapté à vos vergetures." },
  { key: "microneedling", label: "Microneedling", category: "soins", price: 150, desc: "Stimule le renouvellement cellulaire, resserre les pores." },
  { key: "bb_glow", label: "BB Glow", category: "soins", price: 200, desc: "Un teint lumineux pour les fêtes : effet bonne mine progressif. À réserver avant le 15 décembre." },
  { key: "soins_corps_infrarouge", label: "Soins corps infrarouge", category: "soins", price: 45, priceFrom: true, desc: "Chaleur infrarouge, stimule la circulation." },
  { key: "freckles", label: "Taches de rousseur — Freckles", category: "regard", price: 160, desc: "Taches de rousseur pigmentées, placement et intensité personnalisés." },
  { key: "soins_led", label: "Lumière rouge LED · 30 min par zone", category: "soins", price: 40, desc: "30 minutes de lumière rouge par zone : le complément idéal à ajouter à votre soin." },
  { key: "consultation_camouflage", label: "RDV camouflage cicatrices & vergetures", category: "soins", price: 0, desc: "Un rendez-vous de 30 minutes pour étudier ta cicatrice ou tes vergetures." },
  { key: "conseil", label: "Conseil personnalisé", category: "offre", price: null, desc: "Miss’U vous accompagne pour choisir la prestation adaptée à votre projet." },
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
