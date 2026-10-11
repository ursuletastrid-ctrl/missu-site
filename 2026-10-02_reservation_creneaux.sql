-- =====================================================================
-- MYU by Miss'U — Réservation par créneaux réels (02/10/2026)
-- =====================================================================
-- Objectif : un rendez-vous payé = une plage horaire réellement bloquée.
--  * chaque rendez-vous porte un lieu + un début + une fin (fuseau America/Martinique)
--  * "bloque = true" pour un créneau maintenu pendant le paiement ou confirmé ;
--    la contrainte d'exclusion garantit qu'AUCUNE autre plage bloquée ne peut le
--    chevaucher, même si deux paiements arrivent à la même milliseconde ;
--  * suivi de synchronisation agenda Google + feuille "Demandes (secours)".
-- Migration additive : aucune colonne existante n'est supprimée ni renommée.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. Réglages de réservation (une seule ligne, modifiable depuis l'admin)
-- ---------------------------------------------------------------------
create table if not exists public.myu_reglages_reservation (
  id smallint primary key default 1 check (id = 1),
  lieux text[] not null default array['Ducos'],
  -- jour ISO (1 = lundi ... 7 = dimanche) -> liste de plages [début, fin]
  horaires jsonb not null default '{"1":[["09:00","17:00"]],"2":[["09:00","17:00"]],"3":[["09:00","17:00"]],"4":[["09:00","17:00"]],"5":[["09:00","17:00"]],"6":[["09:00","13:00"]]}'::jsonb,
  pas_minutes int not null default 30 check (pas_minutes between 5 and 240),
  delai_min_minutes int not null default 120 check (delai_min_minutes between 0 and 10080),
  horizon_jours int not null default 60 check (horizon_jours between 1 and 365),
  maintien_minutes int not null default 20 check (maintien_minutes between 5 and 60),
  -- événements de l'agenda Google à NE PAS considérer comme bloquants
  -- (recherche dans le titre et le lieu, sans tenir compte des majuscules)
  agenda_mots_ignores text[] not null default array['Collège Édouard Glissant'],
  updated_at timestamptz not null default now()
);
insert into public.myu_reglages_reservation (id) values (1) on conflict (id) do nothing;
alter table public.myu_reglages_reservation enable row level security;

-- ---------------------------------------------------------------------
-- 2. Durée de chaque prestation (3 h par défaut, choix d'Astrid du 02/10)
-- ---------------------------------------------------------------------
alter table public.prestations_reservation
  add column if not exists duree_minutes int not null default 180;
do $$ begin
  alter table public.prestations_reservation
    add constraint prestations_reservation_duree_check check (duree_minutes between 15 and 600);
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- 3. Rendez-vous : lieu, plage horaire, maintien, synchronisations
-- ---------------------------------------------------------------------
alter table public.rendez_vous
  add column if not exists lieu text,
  add column if not exists debut timestamptz,
  add column if not exists fin timestamptz,
  add column if not exists duree_minutes int,
  add column if not exists bloque boolean not null default false,
  add column if not exists maintien_expire_le timestamptz,
  add column if not exists confirme_le timestamptz,
  add column if not exists dossier_id text,
  add column if not exists contact_email text,
  add column if not exists agenda_statut text not null default 'non_requis',
  add column if not exists agenda_evenement_id text,
  add column if not exists agenda_erreur text,
  add column if not exists agenda_tentatives int not null default 0,
  add column if not exists agenda_derniere_tentative timestamptz,
  add column if not exists feuille_statut text not null default 'non_requis',
  add column if not exists feuille_erreur text,
  add column if not exists alerte text;

do $$ begin
  alter table public.rendez_vous add constraint rendez_vous_agenda_statut_check
    check (agenda_statut in ('non_requis','a_synchroniser','ok','erreur','a_retirer','retire'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.rendez_vous add constraint rendez_vous_feuille_statut_check
    check (feuille_statut in ('non_requis','a_synchroniser','ok','erreur'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.rendez_vous add constraint rendez_vous_plage_valide
    check (debut is null or (fin is not null and fin > debut));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.rendez_vous add constraint rendez_vous_bloque_a_une_plage
    check (not bloque or (debut is not null and fin is not null));
exception when duplicate_object then null; end $$;
-- Garantie anti double réservation : une seule praticienne, donc deux plages
-- bloquées ne peuvent JAMAIS se chevaucher (toutes prestations et lieux confondus).
do $$ begin
  alter table public.rendez_vous add constraint rendez_vous_sans_chevauchement
    exclude using gist (tstzrange(debut, fin, '[)') with &&) where (bloque);
exception when duplicate_object or duplicate_table then null; end $$;

create unique index if not exists rendez_vous_dossier_unique
  on public.rendez_vous (dossier_id) where dossier_id is not null;
create unique index if not exists rendez_vous_payment_reference_unique
  on public.rendez_vous (payment_reference) where payment_reference is not null;
create index if not exists rendez_vous_bloque_debut_idx
  on public.rendez_vous (debut) where bloque;
create index if not exists rendez_vous_synchro_idx
  on public.rendez_vous (agenda_statut, feuille_statut);

-- ---------------------------------------------------------------------
-- 4. Confirmation atomique et idempotente d'un acompte vérifié auprès de SumUp
--    (appelée UNIQUEMENT par le serveur, après relecture du paiement chez SumUp)
-- ---------------------------------------------------------------------
create or replace function public.myu_confirmer_paiement(p_rdv uuid, p_reference text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.rendez_vous;
  v_limited boolean;
  v_rem int;
  v_alerte text;
begin
  select * into r from public.rendez_vous where id = p_rdv for update;
  if not found then
    return jsonb_build_object('resultat', 'introuvable');
  end if;
  if r.payment_status = 'paye' then
    return jsonb_build_object('resultat', 'deja_confirme', 'rdv', to_jsonb(r));
  end if;
  if r.payment_reference is distinct from p_reference then
    return jsonb_build_object('resultat', 'reference_incoherente');
  end if;

  begin
    update public.rendez_vous
       set payment_status = 'paye', payment_date = now(), statut = 'confirme',
           confirme_le = now(), bloque = (debut is not null), maintien_expire_le = null,
           agenda_statut = case when debut is not null then 'a_synchroniser' else 'non_requis' end,
           feuille_statut = 'a_synchroniser'
     where id = p_rdv;
  exception when exclusion_violation then
    -- Cas extrême : le maintien avait expiré et le créneau a été repris entre-temps.
    -- Le paiement est conservé, l'alerte est visible dans le suivi admin.
    v_alerte := 'Acompte payé mais ce créneau a été repris entre-temps : à replanifier ou rembourser.';
    update public.rendez_vous
       set payment_status = 'paye', payment_date = now(), statut = 'confirme',
           confirme_le = now(), bloque = false, maintien_expire_le = null,
           agenda_statut = 'non_requis', feuille_statut = 'a_synchroniser', alerte = v_alerte
     where id = p_rdv;
  end;

  select is_limited_offer into v_limited
    from public.prestations_reservation where type_prestation = r.type_prestation;
  if coalesce(v_limited, false) and not coalesce(r.slot_reserved, false) then
    update public.prestations_reservation
       set available_slots = available_slots - 1, updated_at = now()
     where type_prestation = r.type_prestation and available_slots > 0
     returning available_slots into v_rem;
    if v_rem is null then
      v_alerte := concat_ws(' ', v_alerte, 'Offre limitée déjà complète au moment du paiement : place à vérifier.');
      update public.rendez_vous set alerte = v_alerte where id = p_rdv;
    else
      update public.rendez_vous set slot_reserved = true where id = p_rdv;
    end if;
  end if;

  if v_alerte is not null then
    insert into public.notes_internes (client_id, note)
    values (r.client_id, '⚠️ Réservation ' || coalesce(r.dossier_id, r.id::text) || ' : ' || v_alerte);
  end if;

  select * into r from public.rendez_vous where id = p_rdv;
  return jsonb_build_object('resultat', 'confirme', 'alerte', v_alerte, 'rdv', to_jsonb(r));
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Libération d'un créneau maintenu (paiement échoué / annulé / expiré).
--    Ne libère JAMAIS un rendez-vous dont l'acompte est payé. Le serveur
--    n'appelle cette fonction qu'après avoir vérifié chez SumUp qu'aucun
--    paiement n'a abouti.
-- ---------------------------------------------------------------------
create or replace function public.myu_liberer_maintien(p_rdv uuid, p_motif text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.rendez_vous;
begin
  select * into r from public.rendez_vous where id = p_rdv for update;
  if not found then return 'introuvable'; end if;
  if r.payment_status = 'paye' then return 'deja_paye'; end if;
  if r.statut <> 'en_attente_paiement' then return 'pas_en_attente'; end if;
  update public.rendez_vous
     set bloque = false, statut = 'annule', maintien_expire_le = null,
         payment_status = 'echoue',
         alerte = left(coalesce(p_motif, 'Paiement non abouti'), 300)
   where id = p_rdv;
  return 'libere';
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Droits — strictement ce dont les fonctions serveur ont besoin
-- ---------------------------------------------------------------------
revoke all on function public.myu_confirmer_paiement(uuid, text) from public, anon, authenticated;
revoke all on function public.myu_liberer_maintien(uuid, text) from public, anon, authenticated;
grant execute on function public.myu_confirmer_paiement(uuid, text) to service_role;
grant execute on function public.myu_liberer_maintien(uuid, text) to service_role;
grant execute on function public.reserve_modele_slot(text) to service_role;

grant select, update on public.myu_reglages_reservation to service_role;
grant select, update on public.prestations_reservation to service_role;
grant select, insert, update on public.rendez_vous to service_role;
grant insert on public.notes_internes to service_role;

-- Lecture côté navigateur (protégée par les policies RLS déjà en place) :
-- tarifs/acomptes publics, et "Mes rendez-vous" d'une cliente connectée.
grant select on public.prestations_reservation to anon, authenticated;
grant select on public.rendez_vous to authenticated;

commit;
