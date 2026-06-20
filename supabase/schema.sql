-- Bet720 Database Schema
-- Run this in your Supabase SQL editor

create extension if not exists "uuid-ossp";

-- ─────────────────────────────────────────────
-- TABLES (all first, before any cross-referencing policies)
-- ─────────────────────────────────────────────

create table if not exists public.users (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text unique not null,
  avatar_url  text,
  created_at  timestamptz default now() not null
);

create table if not exists public.leagues (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null,
  created_by  uuid references public.users(id) on delete cascade not null,
  sport       text default 'soccer' not null,
  season      text,
  invite_code text unique not null default upper(substring(md5(random()::text), 1, 8)),
  created_at  timestamptz default now() not null
);

create table if not exists public.league_members (
  id            uuid primary key default uuid_generate_v4(),
  league_id     uuid references public.leagues(id) on delete cascade not null,
  user_id       uuid references public.users(id) on delete cascade not null,
  total_points  integer default 0 not null,
  joined_at     timestamptz default now() not null,
  unique(league_id, user_id)
);

create table if not exists public.matches (
  id            uuid primary key default uuid_generate_v4(),
  external_id   integer unique not null,
  home_team     text not null,
  away_team     text not null,
  home_crest    text,
  away_crest    text,
  competition   text not null,
  kickoff_at    timestamptz not null,
  status        text default 'scheduled' check (status in ('scheduled','live','finished','postponed')) not null,
  home_score    integer,
  away_score    integer,
  matchday      integer,
  season        text,
  updated_at    timestamptz default now() not null
);

create table if not exists public.predictions (
  id                uuid primary key default uuid_generate_v4(),
  user_id           uuid references public.users(id) on delete cascade not null,
  match_id          uuid references public.matches(id) on delete cascade not null,
  league_id         uuid references public.leagues(id) on delete cascade not null,
  prediction_type   text check (prediction_type in ('result','exact_score','btts')) not null,
  predicted_value   text not null,
  risk_tier         text check (risk_tier in ('low','medium','high')) not null,
  points_wagered    integer not null check (points_wagered >= 10 and points_wagered <= 100),
  points_won        integer,
  double_or_nothing boolean default false not null,
  resolved          boolean default false not null,
  created_at        timestamptz default now() not null,
  unique(user_id, match_id, league_id, prediction_type)
);

create table if not exists public.feed_reactions (
  id            uuid primary key default uuid_generate_v4(),
  prediction_id uuid references public.predictions(id) on delete cascade not null,
  user_id       uuid references public.users(id) on delete cascade not null,
  emoji         text not null,
  created_at    timestamptz default now() not null,
  unique(prediction_id, user_id, emoji)
);

-- ─────────────────────────────────────────────
-- ROW LEVEL SECURITY (enable on all tables)
-- ─────────────────────────────────────────────

alter table public.users           enable row level security;
alter table public.leagues         enable row level security;
alter table public.league_members  enable row level security;
alter table public.matches         enable row level security;
alter table public.predictions     enable row level security;
alter table public.feed_reactions  enable row level security;

-- ─────────────────────────────────────────────
-- POLICIES: users
-- ─────────────────────────────────────────────

create policy "Users can view all profiles"
  on public.users for select using (true);

create policy "Users can insert their own profile"
  on public.users for insert with check (auth.uid() = id);

create policy "Users can update their own profile"
  on public.users for update using (auth.uid() = id);

-- ─────────────────────────────────────────────
-- HELPER: membership check (SECURITY DEFINER bypasses RLS to
-- avoid infinite recursion in league_members policies)
-- ─────────────────────────────────────────────

create or replace function public.is_league_member(p_league_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.league_members
    where league_id = p_league_id and user_id = auth.uid()
  );
$$;

-- ─────────────────────────────────────────────
-- POLICIES: league_members (defined before leagues uses it)
-- ─────────────────────────────────────────────

create policy "Users can view members of leagues they belong to"
  on public.league_members for select
  using (public.is_league_member(league_id));

create policy "Users can join leagues"
  on public.league_members for insert with check (auth.uid() = user_id);

create policy "System can update member points"
  on public.league_members for update using (auth.uid() = user_id);

-- ─────────────────────────────────────────────
-- POLICIES: leagues (now league_members exists)
-- ─────────────────────────────────────────────

create policy "League members can view their leagues"
  on public.leagues for select
  using (public.is_league_member(id));

create policy "Authenticated users can create leagues"
  on public.leagues for insert with check (auth.uid() = created_by);

create policy "League creator can update their league"
  on public.leagues for update using (auth.uid() = created_by);

-- ─────────────────────────────────────────────
-- POLICIES: matches
-- ─────────────────────────────────────────────

create policy "Anyone can view matches"
  on public.matches for select using (true);

create policy "Authenticated users can insert matches"
  on public.matches for insert with check (auth.uid() is not null);

create policy "Authenticated users can update matches"
  on public.matches for update using (auth.uid() is not null);

-- ─────────────────────────────────────────────
-- POLICIES: predictions
-- ─────────────────────────────────────────────

create policy "League members can view predictions in their leagues"
  on public.predictions for select
  using (public.is_league_member(league_id));

create policy "Users can create their own predictions"
  on public.predictions for insert with check (auth.uid() = user_id);

create policy "Users can update their own unresolved predictions"
  on public.predictions for update using (auth.uid() = user_id and resolved = false);

-- ─────────────────────────────────────────────
-- POLICIES: feed_reactions
-- ─────────────────────────────────────────────

create policy "League members can view reactions"
  on public.feed_reactions for select using (
    exists (
      select 1 from public.predictions p
      where p.id = feed_reactions.prediction_id
        and public.is_league_member(p.league_id)
    )
  );

create policy "Users can add reactions"
  on public.feed_reactions for insert with check (auth.uid() = user_id);

create policy "Users can remove their own reactions"
  on public.feed_reactions for delete using (auth.uid() = user_id);

-- ─────────────────────────────────────────────
-- REALTIME
-- ─────────────────────────────────────────────

alter publication supabase_realtime add table public.predictions;
alter publication supabase_realtime add table public.feed_reactions;
alter publication supabase_realtime add table public.matches;

-- ─────────────────────────────────────────────
-- TRIGGER: auto-create user profile on signup
-- ─────────────────────────────────────────────

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.users (id, username, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─────────────────────────────────────────────
-- FUNCTION: resolve predictions after match ends
-- ─────────────────────────────────────────────

create or replace function public.resolve_predictions(p_match_id uuid)
returns void language plpgsql security definer as $$
declare
  v_match record;
  v_pred  record;
  v_correct boolean;
  v_multiplier numeric;
  v_points integer;
  v_actual_result text;
begin
  select * into v_match from public.matches where id = p_match_id;
  if v_match.status <> 'finished' then return; end if;

  if v_match.home_score > v_match.away_score then
    v_actual_result := '1';
  elsif v_match.home_score = v_match.away_score then
    v_actual_result := 'X';
  else
    v_actual_result := '2';
  end if;

  for v_pred in
    select * from public.predictions
    where match_id = p_match_id and resolved = false
  loop
    v_correct := false;
    v_multiplier := 1;

    case v_pred.prediction_type
      when 'result' then
        v_correct := (v_pred.predicted_value = v_actual_result);
        v_multiplier := 1;
      when 'exact_score' then
        v_correct := (v_pred.predicted_value = (v_match.home_score::text || '-' || v_match.away_score::text));
        v_multiplier := 5;
      when 'btts' then
        v_correct := (
          (v_pred.predicted_value = 'yes' and v_match.home_score > 0 and v_match.away_score > 0) or
          (v_pred.predicted_value = 'no'  and (v_match.home_score = 0 or v_match.away_score = 0))
        );
        v_multiplier := 2;
    end case;

    if v_pred.double_or_nothing then
      v_multiplier := v_multiplier * 2;
    end if;

    if v_correct then
      v_points := (v_pred.points_wagered * v_multiplier)::integer;
    else
      if v_pred.double_or_nothing then
        v_points := -(v_pred.points_wagered * 2);
      else
        v_points := -v_pred.points_wagered;
      end if;
    end if;

    update public.predictions
    set points_won = v_points, resolved = true
    where id = v_pred.id;

    update public.league_members
    set total_points = total_points + v_points
    where league_id = v_pred.league_id and user_id = v_pred.user_id;
  end loop;
end;
$$;
