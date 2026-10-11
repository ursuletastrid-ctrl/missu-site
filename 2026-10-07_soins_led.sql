-- =====================================================================
-- MYU by Miss'U — Nouvelle prestation « Soins lumière LED » (07/10/2026)
-- =====================================================================
-- À exécuter UNE fois dans Supabase → SQL Editor (projet myu-espace-client).
-- Migration additive : aucune colonne existante n'est supprimée ni renommée,
-- les autres prestations ne sont pas modifiées.
--
-- Principe :
--  * la table myu_prestations_vitrine porte ce qu'Astrid modifie depuis son
--    espace admin (texte, visuel, prix, durée, statut, consentement) ;
--  * un déclencheur recopie automatiquement prix → acompte 50 %, durée et
--    statut dans prestations_reservation (table déjà utilisée par le serveur
--    de réservation) : « Bientôt disponible » = active false = aucune
--    disponibilité, aucune réservation, aucun paiement possible côté serveur ;
--  * un second déclencheur empêche toute autre écriture (ancien écran,
--    requête manuelle) de rendre la prestation réservable sans passer par le
--    statut « Réservable » ;
--  * le statut « Réservable » est refusé par la base tant que la case
--    « notice et protocole vérifiés » n'a pas été cochée (aucun lancement
--    automatique).
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. Vitrine des prestations gérées depuis l'admin
-- ---------------------------------------------------------------------
create table if not exists public.myu_prestations_vitrine (
  type_prestation text primary key check (type_prestation ~ '^[a-z0-9_]{2,60}$'),
  libelle text not null check (char_length(libelle) between 2 and 80),
  categorie text not null default 'soins_beaute',
  categorie_libelle text not null default 'Soins beauté',
  description text not null default '' check (char_length(description) <= 2000),
  prix numeric(8,2) not null check (prix > 0 and prix <= 5000),
  duree_minutes int not null check (duree_minutes between 15 and 600),
  duree_note text check (duree_note is null or char_length(duree_note) <= 300),
  statut text not null default 'bientot' check (statut in ('bientot', 'reservable', 'masque')),
  visuel_url text check (visuel_url is null or visuel_url ~ '^(https://|/)'),
  whatsapp_message text check (whatsapp_message is null or char_length(whatsapp_message) <= 500),
  -- Engagements propres à la prestation, cochés avant le paiement :
  -- [{ "key": "...", "label": "..." }]. Jamais de champ libre santé.
  consentement jsonb not null default '[]'::jsonb check (jsonb_typeof(consentement) = 'array'),
  consentement_version text not null default '1',
  notice_verifiee_le timestamptz,
  updated_at timestamptz not null default now(),
  constraint myu_vitrine_activation_verifiee
    check (statut <> 'reservable' or notice_verifiee_le is not null)
);

alter table public.myu_prestations_vitrine enable row level security;
drop policy if exists "vitrine lecture publique" on public.myu_prestations_vitrine;
create policy "vitrine lecture publique" on public.myu_prestations_vitrine
  for select to anon, authenticated using (statut <> 'masque');
grant select on public.myu_prestations_vitrine to anon, authenticated;
grant select, insert, update on public.myu_prestations_vitrine to service_role;

-- ---------------------------------------------------------------------
-- 2. Montant total connu au moment de la réservation (affichage du solde)
-- ---------------------------------------------------------------------
alter table public.rendez_vous add column if not exists prix_total numeric(8,2);

-- ---------------------------------------------------------------------
-- 3. Vitrine → prestations_reservation (acompte 50 %, durée, réservable)
-- ---------------------------------------------------------------------
create or replace function public.myu_vitrine_vers_reservation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.prestations_reservation
    (type_prestation, deposit_amount, active, duree_minutes, is_limited_offer, updated_at)
  values
    (new.type_prestation, round(new.prix * 0.5, 2), new.statut = 'reservable', new.duree_minutes, false, now())
  on conflict (type_prestation) do update
    set deposit_amount = excluded.deposit_amount,
        active = excluded.active,
        duree_minutes = excluded.duree_minutes,
        updated_at = now();
  return new;
end;
$$;

drop trigger if exists myu_vitrine_sync on public.myu_prestations_vitrine;
create trigger myu_vitrine_sync
  after insert or update on public.myu_prestations_vitrine
  for each row execute function public.myu_vitrine_vers_reservation();

-- Garde-fou : pour une prestation gérée par la vitrine, prestations_reservation
-- reflète TOUJOURS la vitrine, quel que soit l'écran ou la requête qui l'écrit.
create or replace function public.myu_reservation_suit_vitrine()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.myu_prestations_vitrine;
begin
  select * into v from public.myu_prestations_vitrine where type_prestation = new.type_prestation;
  if found then
    new.active := (v.statut = 'reservable');
    new.deposit_amount := round(v.prix * 0.5, 2);
    new.duree_minutes := v.duree_minutes;
    new.is_limited_offer := false;
  end if;
  return new;
end;
$$;

drop trigger if exists myu_reservation_suit_vitrine on public.prestations_reservation;
create trigger myu_reservation_suit_vitrine
  before insert or update on public.prestations_reservation
  for each row execute function public.myu_reservation_suit_vitrine();

revoke all on function public.myu_vitrine_vers_reservation() from public, anon, authenticated;
revoke all on function public.myu_reservation_suit_vitrine() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. Prestation « Soins lumière LED » — statut initial : Bientôt disponible
-- ---------------------------------------------------------------------
insert into public.myu_prestations_vitrine
  (type_prestation, libelle, categorie, categorie_libelle, description, prix, duree_minutes, duree_note,
   statut, visuel_url, whatsapp_message, consentement, consentement_version)
values (
  'soins_led',
  'Soins lumière LED',
  'soins_beaute',
  'Soins beauté',
  'Une nouvelle parenthèse beauté chez MYU. Découvrez prochainement nos séances de lumière LED, avec un accompagnement personnalisé.',
  25,
  30,
  'Accueil et installation compris. Le temps d''exposition sera adapté à la notice de l''appareil.',
  'bientot',
  null,
  'Bonjour Miss''U, je souhaite être informé(e) du lancement des soins lumière LED à 25 € chez MYU.',
  '[
    {"key": "description_lue", "label": "J''ai lu la description de la séance de lumière LED. Aucun résultat précis ne m''est promis."},
    {"key": "exposition_notice", "label": "Je sais que le temps d''exposition est adapté à la notice de l''appareil et que Miss''U peut adapter ou reporter la séance si elle le juge nécessaire."},
    {"key": "questions_directes", "label": "Si j''ai une question sur ma situation, je la poserai directement à Miss''U avant la séance (rien à indiquer en ligne)."},
    {"key": "consignes_led", "label": "Je m''engage à suivre les consignes transmises par Miss''U pour ce soin."}
  ]'::jsonb,
  '2026-10-07'
)
on conflict (type_prestation) do nothing;

-- Bucket public pour les visuels de la vitrine (affiche MYU LED…).
-- Écriture réservée au serveur (clé service_role) ; lecture publique.
insert into storage.buckets (id, name, public)
values ('vitrine', 'vitrine', true)
on conflict (id) do nothing;

commit;

-- Vérification (doit afficher active = false, deposit_amount = 12.50, duree_minutes = 30) :
-- select type_prestation, active, deposit_amount, duree_minutes from public.prestations_reservation where type_prestation = 'soins_led';
