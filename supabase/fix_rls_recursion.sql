-- ─────────────────────────────────────────────
-- FIX: infinite recursion in league_members policy
-- Run this in the Supabase SQL editor.
--
-- The old SELECT policy on league_members queried league_members
-- from inside its own policy → infinite recursion. The fix is a
-- SECURITY DEFINER helper function that bypasses RLS when checking
-- membership, so the policy can call it without recursing.
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

-- ── league_members ──────────────────────────
drop policy if exists "Users can view members of leagues they belong to" on public.league_members;
create policy "Users can view members of leagues they belong to"
  on public.league_members for select
  using (public.is_league_member(league_id));

-- ── leagues ─────────────────────────────────
drop policy if exists "League members can view their leagues" on public.leagues;
create policy "League members can view their leagues"
  on public.leagues for select
  using (public.is_league_member(id));

-- ── predictions ─────────────────────────────
drop policy if exists "League members can view predictions in their leagues" on public.predictions;
create policy "League members can view predictions in their leagues"
  on public.predictions for select
  using (public.is_league_member(league_id));

-- ── feed_reactions ──────────────────────────
drop policy if exists "League members can view reactions" on public.feed_reactions;
create policy "League members can view reactions"
  on public.feed_reactions for select
  using (
    exists (
      select 1 from public.predictions p
      where p.id = feed_reactions.prediction_id
        and public.is_league_member(p.league_id)
    )
  );

-- ── season: no longer required ──────────────
alter table public.leagues alter column season drop not null;
alter table public.leagues alter column season set default null;
