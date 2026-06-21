-- ──────────────────────────────────────────────────────────────────────
-- MIGRATION: Daily budget + pre-match-only betting
--
-- Two changes layered on top of secure_bets.sql:
--
-- 1. BUDGET RESET. Previously place_bet summed every prediction in the
--    league lifetime, so a user's 100-pt pool shrank permanently. Now it
--    sums only the current UTC day. Each user gets a fresh 100 pts to
--    spread across that day's fixtures.
--
-- 2. NO MORE LIVE BETTING. Real-money-style live betting requires a
--    suspendable market and we can't safely build one on a 10-req/min
--    free feed. place_bet now rejects bets on live matches with a clear
--    error. Live-match impossible-pick logic stays in the function (dead
--    for now) — when we add free "power-up" predictions during matches
--    they'll route through a separate RPC, so the gating is worth
--    keeping intact.
--
-- 3. The double-or-nothing limit is also moved to the current day so the
--    user gets one DOUBLE per day rather than one per league lifetime —
--    matches the new budget rhythm.
--
-- Run AFTER secure_bets.sql in the Supabase SQL editor. Idempotent.
-- ──────────────────────────────────────────────────────────────────────

create or replace function public.place_bet(
  p_match_id uuid,
  p_league_id uuid,
  p_prediction_type text,
  p_predicted_value text,
  p_points_wagered integer,
  p_double_or_nothing boolean default false
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
  BET_WINDOW_MINS constant integer := 180;
  DAILY_BUDGET    constant integer := 100;
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

  select * into v_match from public.matches where id = p_match_id;
  if not found then raise exception 'match not found'; end if;
  if v_match.status = 'finished' or v_match.status = 'postponed' then
    raise exception 'match is no longer bettable';
  end if;

  -- LIVE betting is disabled for money-style bets. Free in-play "power-up"
  -- predictions will get their own RPC down the line.
  if v_match.status = 'live' then
    raise exception 'live betting is closed — bets must be placed before kickoff';
  end if;

  -- Pre-kickoff window (3h)
  v_mins_to_kickoff := extract(epoch from (v_match.kickoff_at - now())) / 60;
  if v_mins_to_kickoff <= 0 then
    raise exception 'match has started — bets are closed';
  end if;
  if v_mins_to_kickoff > BET_WINDOW_MINS then
    raise exception 'bets open % min before kickoff', BET_WINDOW_MINS;
  end if;

  -- DAILY budget: sum only today's predictions. UTC chosen so all users
  -- reset at the same instant — avoids timezone-shopping for extra points.
  select coalesce(sum(points_wagered), 0) into v_today_total
  from public.predictions
  where user_id = v_user
    and league_id = p_league_id
    and created_at >= v_day_start;
  if v_today_total + p_points_wagered > DAILY_BUDGET then
    raise exception 'daily budget exceeded (% / % pts used today)', v_today_total, DAILY_BUDGET;
  end if;

  -- DOUBLE-or-nothing: one per day (was: one per league lifetime).
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

  -- (Live impossible-pick gating kept for future power-ups — dead while
  -- the status='live' check above rejects all live bets.)

  v_mult := public.compute_bet_multiplier(p_match_id, p_prediction_type, p_predicted_value);

  v_risk := case
    when v_mult < 1.0 then 'low'
    when v_mult < 3.0 then 'medium'
    else 'high'
  end;

  insert into public.predictions (
    user_id, match_id, league_id,
    prediction_type, predicted_value, risk_tier,
    points_wagered, double_or_nothing,
    odds_multiplier, resolved
  ) values (
    v_user, p_match_id, p_league_id,
    p_prediction_type, p_predicted_value, v_risk,
    p_points_wagered, coalesce(p_double_or_nothing, false),
    v_mult, false
  )
  returning * into v_inserted;

  return v_inserted;
end;
$$;

grant execute on function public.place_bet(uuid, uuid, text, text, integer, boolean) to authenticated;

-- ── Verify ────────────────────────────────────────────────────────────
select 'place_bet updated' as check, exists (
  select 1 from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'place_bet'
) as ok;
