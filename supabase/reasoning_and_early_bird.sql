-- ──────────────────────────────────────────────────────────────────────
-- MIGRATION: Bet reasoning + early-bird tier
--
-- Two product additions:
--
-- 1. REASONING. Optional 140-char "hot take" attached to a bet, shown
--    in the feed and on the bets page. Pure social — banter, public
--    rationale, gloating after a win. Stored on the prediction row.
--
-- 2. EARLY-BIRD TIER. The bet window opens at 24h before kickoff
--    instead of 3h, BUT anything placed between 24h and 3h gets its
--    payout multiplier scaled by 0.75. The standard 3h–0h window
--    stays full price. This rewards waiting for late info (lineups,
--    injuries) while still giving committed users a way to lock in
--    picks ahead of time.
--
-- Run AFTER daily_budget_and_pre_match_only.sql in the SQL editor.
-- Idempotent.
-- ──────────────────────────────────────────────────────────────────────

-- ── 1. Reasoning column ───────────────────────────────────────────────
alter table public.predictions
  add column if not exists reasoning text check (length(reasoning) <= 140);

-- ── 2. place_bet: accept reasoning + apply early-bird multiplier ──────
create or replace function public.place_bet(
  p_match_id uuid,
  p_league_id uuid,
  p_prediction_type text,
  p_predicted_value text,
  p_points_wagered integer,
  p_double_or_nothing boolean default false,
  p_reasoning text default null
) returns public.predictions
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_match record;
  v_mins_to_kickoff numeric;
  v_today_total integer;
  v_today_dbl integer;
  v_mult numeric;
  v_risk text;
  v_inserted public.predictions;
  v_day_start timestamptz := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
  v_reasoning text := nullif(btrim(p_reasoning), '');
  STANDARD_WINDOW_MINS constant integer := 180;     -- 3h: full payout
  EARLY_BIRD_MINS      constant integer := 24 * 60; -- 24h: reduced payout
  EARLY_BIRD_FACTOR    constant numeric := 0.75;
  DAILY_BUDGET         constant integer := 100;
begin
  if v_user is null then raise exception 'not authenticated'; end if;

  if not exists (
    select 1 from public.league_members
    where league_id = p_league_id and user_id = v_user
  ) then
    raise exception 'not a member of this league';
  end if;

  if p_points_wagered < 10 or p_points_wagered > 100 then
    raise exception 'points_wagered must be between 10 and 100';
  end if;

  if v_reasoning is not null and length(v_reasoning) > 140 then
    raise exception 'reasoning must be 140 characters or fewer';
  end if;

  select * into v_match from public.matches where id = p_match_id;
  if not found then raise exception 'match not found'; end if;
  if v_match.status = 'finished' or v_match.status = 'postponed' then
    raise exception 'match is no longer bettable';
  end if;

  if v_match.status = 'live' then
    raise exception 'live betting is closed — bets must be placed before kickoff';
  end if;

  -- Pre-kickoff window: now opens at 24h. Anything in the early-bird
  -- band (24h..3h) takes a 0.75x payout hit.
  v_mins_to_kickoff := extract(epoch from (v_match.kickoff_at - now())) / 60;
  if v_mins_to_kickoff <= 0 then
    raise exception 'match has started — bets are closed';
  end if;
  if v_mins_to_kickoff > EARLY_BIRD_MINS then
    raise exception 'bets open 24h before kickoff';
  end if;

  -- Daily budget
  select coalesce(sum(points_wagered), 0) into v_today_total
  from public.predictions
  where user_id = v_user
    and league_id = p_league_id
    and created_at >= v_day_start;
  if v_today_total + p_points_wagered > DAILY_BUDGET then
    raise exception 'daily budget exceeded (% / % pts used today)', v_today_total, DAILY_BUDGET;
  end if;

  -- Double-or-nothing: one per day
  if p_double_or_nothing then
    select count(*) into v_today_dbl
    from public.predictions
    where user_id = v_user
      and league_id = p_league_id
      and double_or_nothing = true
      and created_at >= v_day_start;
    if v_today_dbl > 0 then
      raise exception 'double-or-nothing already used today';
    end if;
  end if;

  -- Server-computed odds multiplier
  v_mult := public.compute_bet_multiplier(p_match_id, p_prediction_type, p_predicted_value);

  -- Apply early-bird haircut. The minimum-0.1 floor in decimal_to_mult
  -- already prevents negative multipliers, so the 0.75 scale is safe.
  if v_mins_to_kickoff > STANDARD_WINDOW_MINS then
    v_mult := round((v_mult * EARLY_BIRD_FACTOR)::numeric, 2);
    if v_mult < 0.1 then v_mult := 0.1; end if;
  end if;

  v_risk := case
    when v_mult < 1.0 then 'low'
    when v_mult < 3.0 then 'medium'
    else 'high'
  end;

  insert into public.predictions (
    user_id, match_id, league_id,
    prediction_type, predicted_value, risk_tier,
    points_wagered, double_or_nothing,
    odds_multiplier, resolved, reasoning
  ) values (
    v_user, p_match_id, p_league_id,
    p_prediction_type, p_predicted_value, v_risk,
    p_points_wagered, coalesce(p_double_or_nothing, false),
    v_mult, false, v_reasoning
  )
  returning * into v_inserted;

  return v_inserted;
end;
$$;

-- Old 6-arg signature was the previous version of place_bet — drop it
-- so PostgREST routes the 7-arg call cleanly.
drop function if exists public.place_bet(uuid, uuid, text, text, integer, boolean);
grant execute on function public.place_bet(uuid, uuid, text, text, integer, boolean, text) to authenticated;

-- ── Verify ────────────────────────────────────────────────────────────
select
  'place_bet 7-arg exists' as check,
  exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'place_bet'
      and pronargs = 7
  ) as ok
union all
select 'reasoning column exists', exists (
  select 1 from information_schema.columns
  where table_schema = 'public' and table_name = 'predictions' and column_name = 'reasoning'
);
