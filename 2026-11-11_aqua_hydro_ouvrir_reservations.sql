-- Ouvre les réservations du soin visage Aqua Hydro (180 €, acompte 90 €).
-- À lancer seulement après vérification de la notice / du protocole de l'appareil.
update public.myu_prestations_vitrine
   set statut = 'reservable', notice_verifiee_le = now(), updated_at = now()
 where type_prestation = 'aqua_hydro';

-- Contrôle : doit afficher active = true, deposit_amount = 90.00, duree_minutes = 60
select type_prestation, active, deposit_amount, duree_minutes
  from public.prestations_reservation where type_prestation = 'aqua_hydro';
