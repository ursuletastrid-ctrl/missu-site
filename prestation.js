const fiches = {
  candy_lips: [
    "Un dégradé de couleur qui donne aux lèvres un effet ombré.",
    "Nous choisissons la teinte et l’intensité ensemble. Le dégradé est dessiné pour suivre la forme de vos lèvres."
  ],
  velvet_lips: [
    "Une couleur uniforme du contour au centre, pour un effet blush plus soutenu.",
    "Nous regardons ensemble votre couleur naturelle et l’effet recherché avant de choisir la teinte."
  ],
  aqualips_blush: [
    "Une pigmentation légère pour apporter un voile de couleur aux lèvres.",
    "Nous choisissons la nuance en tenant compte de votre teinte naturelle et de la discrétion souhaitée."
  ],
  neutralisation: [
    "Une correction colorimétrique pensée pour les lèvres naturellement foncées ou présentant plusieurs tonalités.",
    "J’observe la répartition des tons avant de choisir la correction. Le nombre de séances et la suite du protocole se discutent selon la réponse de vos lèvres."
  ],
  powder_brows: [
    "Un effet poudré et modulable qui redessine les sourcils.",
    "Le tracé est préparé selon la forme du visage et de vos sourcils. Vous validez le dessin et l’intensité avant la pigmentation."
  ],
  eyeliner_classique: [
    "Un trait net au ras des cils pour souligner le regard.",
    "Nous définissons l’épaisseur et la longueur du trait en fonction de la forme de votre paupière et de l’effet souhaité."
  ],
  eyeliner_poudre: [
    "Un tracé qui se fond en un ombré doux au-dessus de la ligne des cils.",
    "Nous définissons ensemble la forme du tracé et l’intensité de l’estompe avant la pigmentation."
  ],
  taches_brunes_visage: [
    "Un rendez-vous consacré aux zones de pigmentation que vous souhaitez aborder sur le visage.",
    "Présentez la zone qui vous préoccupe et votre objectif. Le rendez-vous permet de déterminer si MYU propose une option adaptée."
  ],
  taches_brunes_corps: [
    "Une prise en charge envisagée par zone selon l’étendue de la pigmentation.",
    "Nous repérons ensemble les zones concernées. Le tarif est précisé en fonction de leur nombre et de leur étendue."
  ],
  vergetures: [
    "Une prestation de camouflage pigmentaire étudiée selon l’aspect et la couleur de la zone.",
    "Nous examinons la zone et discutons du rendu souhaité. Le tarif dépend de la surface à travailler."
  ],
  microneedling: [
    "Un rendez-vous pour discuter de votre objectif concernant l’aspect de votre peau.",
    "Avant le soin, nous faisons le point sur la zone, votre routine et les informations utiles pour déterminer si le rendez-vous est adapté."
  ],
  bb_glow: [
    "Un soin du visage destiné aux personnes qui recherchent un effet bonne mine.",
    "Nous discutons de l’effet souhaité, de votre routine et de la manière dont votre peau réagit habituellement aux soins."
  ],
  soins_corps_infrarouge: [
    "Une séance de chaleur infrarouge ciblée sur une zone du corps.",
    "Indiquez la zone qui vous intéresse pour que nous puissions préciser le déroulement et le tarif de la séance."
  ],
  conseil: [
    "Un échange pour choisir la prestation qui correspond à votre projet.",
    "Parlez-moi du rendu que vous souhaitez. Nous pouvons comparer les options et préciser les étapes avant de décider."
  ],
  modele_myu: [
    "Une offre à tarif modèle selon les prestations et les places ouvertes.",
    "Consultez les disponibilités pour voir les créneaux proposés. Le studio précise la prestation concernée et les conditions de l’offre."
  ]
};

const key = new URLSearchParams(location.search).get("service");
const service = window.myuFindService(key);
const fiche = Object.hasOwn(fiches, key) ? fiches[key] : null;

if (service && fiche) {
  const mark = {
    levres: "myu_cover_levres",
    regard: "myu_cover_sourcils"
  }[service.category] || "myu_cover_accueil";
  document.title = service.label + " · MYU by Miss’U";
  document.getElementById("service-title").textContent = service.label;
  document.getElementById("service-description").textContent = fiche[0];
  document.getElementById("service-details").textContent = fiche[1];
  document.getElementById("service-price").textContent = window.myuFormatPrice(service);
  document.getElementById("book").href = "/book.html?service=" + encodeURIComponent(key);
  document.getElementById("mark").src = "/assets/myu/brand/" + mark + ".webp";

  const visual = document.getElementById("visual");
  if (key === "neutralisation") {
    const video = document.createElement("video");
    video.src = "/assets/myu/realisations/neutralisation-avant-apres.mp4";
    video.poster = "/assets/myu/realisations/neutralisation-avant-apres.webp";
    video.controls = true;
    video.playsInline = true;
    video.preload = "none";
    video.setAttribute("aria-label", "Avant et après d’une neutralisation des lèvres réalisée au studio");
    visual.append(video);
    document.getElementById("studio-title").textContent = "Une réalisation MYU";
    document.getElementById("visual-caption").textContent = "Avant et après sur une cliente MYU. Le rendu évolue pendant la cicatrisation.";
  } else {
    const image = document.createElement("img");
    image.src = "/assets/myu/studio/myu-beauty-studio-lamentin.webp";
    image.alt = "Le studio MYU au Lamentin";
    image.loading = "lazy";
    image.decoding = "async";
    visual.append(image);
  }
  document.getElementById("unavailable").hidden = true;
  document.getElementById("sheet").hidden = false;
}
