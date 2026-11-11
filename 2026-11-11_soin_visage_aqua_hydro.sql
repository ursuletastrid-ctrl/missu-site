-- =====================================================================
-- MYU by Miss'U — Nouvelle prestation « Soin visage Aqua Hydro » (11/11/2026)
-- =====================================================================
-- À exécuter UNE fois dans Supabase → SQL Editor (projet myu-espace-client).
-- Prérequis : la migration 2026-10-07_soins_led.sql a déjà été exécutée
-- (table myu_prestations_vitrine + déclencheurs).
-- Migration additive : aucune autre prestation n'est modifiée.
--
-- Tarif découverte : 180 € · durée : 60 min · acompte automatique 50 % = 90 €.
-- =====================================================================
begin;

insert into public.myu_prestations_vitrine
  (type_prestation, libelle, categorie, categorie_libelle, description, prix, duree_minutes, duree_note,
   statut, visuel_url, whatsapp_message, consentement, consentement_version)
values (
  'aqua_hydro',
  'Soin visage Aqua Hydro',
  'soins_beaute',
  'Soins beauté',
  'Une peau plus douce, un teint plus frais. Nettoyage, exfoliation et hydratation du visage dans une même séance, avec un accueil personnalisé chez MYU Beauty Studio, Le Lamentin. Tarif découverte : 180 €.',
  180,
  60,
  'Accueil et installation compris.',
  'bientot',
  null,
  'Bonjour Miss''U, je souhaite réserver le soin visage Aqua Hydro au tarif découverte de 180 € chez MYU.',
  '[
    {"key": "description_lue", "label": "J''ai lu la description du soin visage Aqua Hydro. Aucun résultat précis ne m''est promis."},
    {"key": "questions_directes", "label": "Si j''ai une question sur ma peau ou ma situation, je la poserai directement à Miss''U avant la séance (rien à indiquer en ligne)."},
    {"key": "adaptation_seance", "label": "Je sais que Miss''U peut adapter ou reporter la séance si elle le juge nécessaire."},
    {"key": "consignes_soin", "label": "Je m''engage à suivre les consignes transmises par Miss''U pour ce soin."}
  ]'::jsonb,
  '2026-11-11'
)
on conflict (type_prestation) do nothing;

commit;

-- Vérification (doit afficher active = false, deposit_amount = 90.00, duree_minutes = 60) :
-- select type_prestation, active, deposit_amount, duree_minutes
--   from public.prestations_reservation where type_prestation = 'aqua_hydro';

-- =====================================================================
-- MISE EN LIGNE « RÉSERVABLE » — à lancer seulement quand TU as vérifié la
-- notice / le protocole de l'appareil (la base refuse sinon).
-- Décommente et exécute :
-- =====================================================================
-- update public.myu_prestations_vitrine
--    set statut = 'reservable', notice_verifiee_le = now(), updated_at = now()
--  where type_prestation = 'aqua_hydro';
