// Service worker minimal MYU by Miss'U — installabilité uniquement, aucune mise en cache.
// Un navigateur/téléphone n'affiche le bouton "Ajouter à l'écran d'accueil" / "Installer"
// que si un service worker est enregistré : c'est tout ce que celui-ci fait. Il ne
// stocke rien hors-ligne, ne modifie aucune requête, pour ne prendre aucun risque avec
// le pré-diagnostic, Supabase ou les fonctions /api existantes.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Volontairement pas de "fetch" intercepté : toutes les requêtes (site, Supabase,
// EmailJS, Google Apps Script) continuent de passer normalement par le réseau.
