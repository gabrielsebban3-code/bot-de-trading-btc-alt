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

-- Liens d'invitation Premium : l'admin crée un lien (bouton dans Mon compte), la personne l'ouvre, se connecte
-- et devient Premium toute seule. Chaque lien a un nombre de places, une durée de Premium et une date de fin.
--   days    : jours de Premium à compter de l'activation (vide = sans fin)
--   expires : dernier jour où le lien marche (vide = sans fin)
-- Le site ne lit ni n'écrit ces tables directement : tout passe par les fonctions ci-dessous.
create table if not exists public.premium_invites (
  code text primary key check (code ~ '^[A-Z0-9]{8,32}$'),
  max_uses int not null default 10 check (max_uses between 1 and 1000),
  uses int not null default 0,
  days int check (days between 1 and 3650),
  expires date,
  active boolean not null default true,
  note text check (char_length(note) <= 80),
  created_at timestamptz not null default now()
);
create table if not exists public.premium_invite_uses (
  code text not null references public.premium_invites (code) on delete cascade,
  email text not null,
  used_at timestamptz not null default now(),
  primary key (code, email)
);
alter table public.premium_invites enable row level security;
alter table public.premium_invite_uses enable row level security;
drop policy if exists "invitations : admin" on public.premium_invites;
create policy "invitations : admin" on public.premium_invites for select to authenticated using ((select public.is_admin()));
drop policy if exists "invitations utilisées : admin" on public.premium_invite_uses;
create policy "invitations utilisées : admin" on public.premium_invite_uses for select to authenticated using ((select public.is_admin()));
revoke all on public.premium_invites, public.premium_invite_uses from anon, authenticated;
grant select on public.premium_invites, public.premium_invite_uses to authenticated;

-- Activer une invitation pour le compte connecté. Réponse : { ok, until } ou { ok: false, reason }.
-- reason : login (pas connecté), invalid (lien inconnu ou arrêté), expired (date passée), full (plus de place).
-- Rouvrir le même lien ne prend pas une deuxième place. Un Premium déjà plus long (ou sans fin) n'est jamais raccourci.
create or replace function public.redeem_premium_invite(invite text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  mail text := lower(auth.jwt() ->> 'email');
  inv public.premium_invites;
  ends date;
begin
  if coalesce(mail, '') = '' then return jsonb_build_object('ok', false, 'reason', 'login'); end if;
  select * into inv from public.premium_invites where code = upper(invite) for update;
  if not found or not inv.active then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if exists (select 1 from public.premium_invite_uses u where u.code = inv.code and u.email = mail) then
    select p.until into ends from public.premium p where lower(p.email) = mail;
    return jsonb_build_object('ok', true, 'again', true, 'until', ends);
  end if;
  if inv.expires is not null and inv.expires < current_date then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  if inv.uses >= inv.max_uses then return jsonb_build_object('ok', false, 'reason', 'full'); end if;
  ends := case when inv.days is null then null else current_date + inv.days end;
  insert into public.premium as p (email, until, note) values (mail, ends, 'invitation ' || inv.code)
  on conflict (email) do update
    set until = case when p.until is null or excluded.until is null then null else greatest(p.until, excluded.until) end;
  insert into public.premium_invite_uses (code, email) values (inv.code, mail);
  update public.premium_invites set uses = uses + 1 where code = inv.code;
  select p.until into ends from public.premium p where lower(p.email) = mail;
  return jsonb_build_object('ok', true, 'until', ends);
end $$;
revoke all on function public.redeem_premium_invite(text) from public, anon;
grant execute on function public.redeem_premium_invite(text) to authenticated;

-- Créer un lien (admin seulement). Le code est tiré au hasard : 16 caractères, impossible à deviner.
create or replace function public.create_premium_invite(places int, days int, expires date, note text) returns text
language plpgsql security definer set search_path = '' as $$
declare c text := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16));
begin
  if not public.is_admin() then raise exception 'réservé à l''admin'; end if;
  insert into public.premium_invites (code, max_uses, days, expires, note)
  values (c, places, create_premium_invite.days, create_premium_invite.expires, nullif(trim(create_premium_invite.note), ''));
  return c;
end $$;
revoke all on function public.create_premium_invite(int, int, date, text) from public, anon;
grant execute on function public.create_premium_invite(int, int, date, text) to authenticated;

-- Arrêter un lien (admin seulement) : plus personne ne peut l'utiliser, ceux qui l'ont déjà utilisé gardent Premium.
create or replace function public.stop_premium_invite(invite text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'réservé à l''admin'; end if;
  update public.premium_invites set active = false where code = upper(invite);
end $$;
revoke all on function public.stop_premium_invite(text) from public, anon;
grant execute on function public.stop_premium_invite(text) to authenticated;

-- Bouton « Supprimer mon compte » : efface le compte de la personne connectée (et sa ligne, par cascade),
-- et sa ligne Premium s'il en a une : rien ne reste de lui (promis dans legal/confidentialite.html).
create or replace function public.delete_my_account() returns void
language sql security definer set search_path = '' as $$
  delete from public.premium p where lower(p.email) = lower(auth.jwt() ->> 'email');
  delete from public.premium_invite_uses u where u.email = lower(auth.jwt() ->> 'email');
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
  ), invites as (
    delete from public.premium_invite_uses u where u.email in (select lower(g.email) from gone g)
  )
  select count(*)::int from gone
$$;
revoke all on function public.purge_inactive_accounts() from public, anon, authenticated;
select cron.schedule('dinexo-comptes-inactifs', '30 3 * * 1', 'select public.purge_inactive_accounts()');
