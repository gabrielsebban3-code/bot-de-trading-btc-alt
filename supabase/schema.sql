-- Dinexo : comptes et watchlists (Supabase).
-- À coller une fois dans Supabase → SQL Editor → New query → Run. Le script peut être relancé sans risque.
-- Chaque compte ne voit et ne modifie que sa propre ligne ; l'admin (table admins) voit la liste des inscrits.

-- Une ligne par compte : son adresse et sa watchlist (symboles comme BTC, CL ou le ticker d'un projet).
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  watchlist text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 50 symboles au plus, en majuscules, lettres et chiffres (mêmes règles que js/watchlist.js).
create or replace function public.valid_watchlist(list text[]) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(cardinality(list), 0) <= 50 and coalesce(bool_and(s ~ '^[A-Z0-9]{1,15}$'), true) from unnest(list) as s
$$;
alter table public.profiles drop constraint if exists profiles_watchlist_check;
alter table public.profiles add constraint profiles_watchlist_check check (public.valid_watchlist(watchlist));

-- Adresses des admins. Aucune règle d'accès : la table est invisible depuis le site.
create table if not exists public.admins (email text primary key);
alter table public.admins enable row level security;
revoke all on public.admins from anon, authenticated;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admins a where lower(a.email) = lower(auth.jwt() ->> 'email'))
$$;

alter table public.profiles enable row level security;
drop policy if exists "profil : lecture" on public.profiles;
create policy "profil : lecture" on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));
drop policy if exists "profil : création" on public.profiles;
create policy "profil : création" on public.profiles for insert to authenticated
  with check (id = (select auth.uid()) and email = (select auth.jwt() ->> 'email'));
drop policy if exists "profil : watchlist" on public.profiles;
create policy "profil : watchlist" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Dernière visite du membre : sert à « Quoi de neuf pour toi ».
alter table public.profiles add column if not exists last_seen timestamptz;

-- Alertes de prix du membre : une liste JSON de 20 alertes au plus (règles détaillées dans js/pricealerts.js).
alter table public.profiles add column if not exists alerts jsonb not null default '[]';
alter table public.profiles drop constraint if exists profiles_alerts_check;
alter table public.profiles add constraint profiles_alerts_check
  check (jsonb_typeof(alerts) = 'array' and jsonb_array_length(alerts) <= 20 and pg_column_size(alerts) < 20000);

-- Le site ne peut écrire que l'adresse à la création, puis la watchlist, la dernière visite et les alertes.
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant insert (id, email) on public.profiles to authenticated;
grant update (watchlist, updated_at, last_seen, alerts) on public.profiles to authenticated;

-- Liens réservés aux membres connectés (invitation Discord…) : lisibles seulement une fois connecté, modifiables
-- seulement depuis Supabase. Exemple :
--   insert into public.member_links (name, url) values ('discord', 'https://discord.gg/xxxx')
--   on conflict (name) do update set url = excluded.url;
create table if not exists public.member_links (name text primary key, url text not null);
alter table public.member_links enable row level security;
drop policy if exists "liens : membres" on public.member_links;
create policy "liens : membres" on public.member_links for select to authenticated using (true);
revoke all on public.member_links from anon, authenticated;
grant select on public.member_links to authenticated;

-- Comptes Premium : une adresse par ligne, ajoutée à la main tant que le paiement en ligne n'existe pas.
-- « until » vide = sans fin ; sinon Premium jusqu'à ce jour inclus. Exemple :
--   insert into public.premium (email, until) values ('adresse-du-membre', '2026-12-31')
--   on conflict (email) do update set until = excluded.until;
-- Pour retirer Premium : delete from public.premium where email = 'adresse-du-membre';
-- Le site ne peut rien y écrire. Chaque membre peut seulement savoir s'il est Premium ; l'admin voit la liste.
create table if not exists public.premium (email text primary key, until date, note text, created_at timestamptz not null default now());
alter table public.premium enable row level security;
drop policy if exists "premium : admin" on public.premium;
create policy "premium : admin" on public.premium for select to authenticated using ((select public.is_admin()));
revoke all on public.premium from anon, authenticated;
grant select on public.premium to authenticated;

-- Premium si l'adresse du compte est dans la table (et pas expirée), ou si c'est l'admin.
create or replace function public.is_premium() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_admin() or exists (
    select 1 from public.premium p
    where lower(p.email) = lower(auth.jwt() ->> 'email') and (p.until is null or p.until >= current_date)
  )
$$;
revoke all on function public.is_premium() from public, anon;
grant execute on function public.is_premium() to authenticated;

-- Bouton « Supprimer mon compte » : efface le compte de la personne connectée (et sa ligne, par cascade),
-- et sa ligne Premium s'il en a une : rien ne reste de lui (promis dans legal/confidentialite.html).
create or replace function public.delete_my_account() returns void
language sql security definer set search_path = '' as $$
  delete from public.premium p where lower(p.email) = lower(auth.jwt() ->> 'email');
  delete from auth.users where id = auth.uid()
$$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- Comptes inactifs : supprimés après 3 ans sans visite connectée (durée annoncée dans legal/confidentialite.html).
-- Tâche planifiée chaque lundi à 3 h 30 (UTC) avec pg_cron ; les comptes admins ne sont jamais supprimés.
create extension if not exists pg_cron with schema pg_catalog;
create or replace function public.purge_inactive_accounts() returns integer
language sql security definer set search_path = '' as $$
  with gone as (
    delete from auth.users u
    where greatest(u.created_at, u.last_sign_in_at, (select p.last_seen from public.profiles p where p.id = u.id)) < now() - interval '3 years'
      and not exists (select 1 from public.admins a where lower(a.email) = lower(u.email))
    returning u.email
  ), premium as (
    delete from public.premium p where lower(p.email) in (select lower(g.email) from gone g)
  )
  select count(*)::int from gone
$$;
revoke all on function public.purge_inactive_accounts() from public, anon, authenticated;
select cron.schedule('dinexo-comptes-inactifs', '30 3 * * 1', 'select public.purge_inactive_accounts()');
