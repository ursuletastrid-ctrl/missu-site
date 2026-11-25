-- =====================================================================
-- MYU by Miss'U — Avis clientes (25/11/2026)
-- =====================================================================
-- À exécuter UNE fois dans Supabase → SQL Editor (projet myu-espace-client) → Run.
-- Les avis arrivent « en_attente » ; rien n'est publié sans validation
-- d'Astrid sur /avis-gestion.html. Aucune policy RLS : seule l'API (clé
-- service_role côté serveur) lit et écrit cette table.
create table if not exists public.avis (
  id uuid primary key default gen_random_uuid(),
  prenom text not null,
  prestation text not null,
  note smallint not null check (note between 1 and 5),
  commentaire text not null,
  publication_ok boolean not null default false,
  contact text,
  statut text not null default 'en_attente' check (statut in ('en_attente','publie','masque')),
  created_at timestamptz not null default now()
);
alter table public.avis enable row level security;
create index if not exists avis_statut_idx on public.avis (statut, created_at desc);

-- Vérification (doit afficher 0 ligne, sans erreur) :
select count(*) from public.avis;
