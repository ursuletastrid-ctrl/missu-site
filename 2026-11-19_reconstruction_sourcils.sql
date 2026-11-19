-- =====================================================================
-- MYU by Miss'U — Nouvelle prestation « Reconstruction des sourcils » (19/11/2026)
-- =====================================================================
-- À exécuter UNE fois dans Supabase → SQL Editor (projet myu-espace-client).
-- Prix 350 € (1 retouche comprise, retouches suivantes 80 €) → acompte 50 % = 175 €.
-- Durée : 3 h (durée par défaut des prestations MYU), modifiable ensuite dans l'admin.
insert into public.prestations_reservation
  (type_prestation, deposit_amount, active, duree_minutes, is_limited_offer, updated_at)
values
  ('reconstruction_sourcils', 175, true, 180, false, now())
on conflict (type_prestation) do update
  set deposit_amount = excluded.deposit_amount,
      active = excluded.active,
      duree_minutes = excluded.duree_minutes,
      updated_at = now();

-- Vérification (doit afficher active = true, deposit_amount = 175, duree_minutes = 180) :
select type_prestation, active, deposit_amount, duree_minutes
from public.prestations_reservation where type_prestation = 'reconstruction_sourcils';
