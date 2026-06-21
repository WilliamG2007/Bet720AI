-- ──────────────────────────────────────────────────────────────────────
-- MIGRATION: Server-side bet validation (Tier 0 hardening)
--
-- BEFORE: bets were inserted directly from the client. Anyone with the
-- anon key + devtools could insert a row with odds_multiplier = 9999,
-- bet on already-finished matches, or edit any match's score and trigger
-- their own payout. The frontend gates (3h window, budget, one-shot) were
-- cosmetic.
--
-- AFTER:
--   * place_bet RPC: only entry point for creating predictions. Validates
--     match status, kickoff window, budget, double-or-nothing, and
--     RECOMPUTES odds_multiplier from the matches row server-side.
--   * matches: locked to service-role only for INSERT/UPDATE — clients
--     can no longer tamper with scores. The cron and the new
--     /api/sync/matches endpoint use the service role to write.
--   * predictions: UPDATE policy dropped — bets are immutable in the DB
--     (one-shot is enforced, not just a UI convention).
--   * resolve_predictions: NULLIF(odds_multiplier, 1) legacy detection
--     replaced with COALESCE on a nullable column. A legitimately-computed
--     multiplier of exactly 1.00 no longer gets misread as a legacy row.
--
-- Run in Supabase SQL editor. Idempotent — safe to re-run.
-- ──────────────────────────────────────────────────────────────────────

-- ── 1. Helpers ─────────────────────────────────────────────────────────

-- Poisson PMF: P(X = k) for rate lambda. Mirrors poissonPmf() in
-- src/lib/poissonOdds.ts. Marked IMMUTABLE so the planner can cache.
create or replace function public.poisson_pmf(lambda numeric, k integer)
returns numeric language plpgsql immutable as $$
declare
  log_p numeric;
  i integer;
begin
  if lambda <= 0 then return case when k = 0 then 1 else 0 end; end if;
  log_p := -lambda + k * ln(lambda);
  for i in 1..k loop
    log_p := log_p - ln(i);
  end loop;
  return exp(log_p);
end;
$$;

-- Probability → decimal odds with 5% house margin (matches toDecimalOdds).
create or replace function public.prob_to_decimal(p numeric)
returns numeric language sql immutable as $$
  select case
    when p <= 0 then 200
    else least(200, round(((1 / p) * 0.95)::numeric, 2))
  end;
$$;

-- Net-profit multiplier (decimal odds − 1, floored at 0.1 to match
-- decimalToMultiplier in src/lib/poissonOdds.ts).
create or replace function public.decimal_to_mult(d numeric)
returns numeric language sql immutable as $$
  select greatest(0.1::numeric, round((d - 1)::numeric, 2));
$$;

-- Exact-score decimal odds. cur_home/cur_away support live bets where the
-- locked-in goals are not random anymore.
create or replace function public.exact_score_decimal(
  home_exp numeric, away_exp numeric, h integer, a integer,
  cur_home integer default 0, cur_away integer default 0
) returns numeric language plpgsql immutable as $$
declare
  need_h integer := h - cur_home;
  need_a integer := a - cur_away;
  home_rem numeric := greatest(0, home_exp - cur_home);
  away_rem numeric := greatest(0, away_exp - cur_away);
  p numeric;
begin
  if need_h < 0 or need_a < 0 then return 200; end if;
  p := public.poisson_pmf(home_rem, need_h) * public.poisson_pmf(away_rem, need_a);
  return public.prob_to_decimal(greatest(p, 0.002));
end;
$$;

-- Estimate live minute from kickoff (mirrors estimateLiveMinute).
create or replace function public.live_minute(kickoff timestamptz)
returns integer language sql immutable as $$
  select case
    when extract(epoch from (now() - kickoff)) / 60 <= 0 then 0
    when extract(epoch from (now() - kickoff)) / 60 <= 45
      then greatest(1, floor(extract(epoch from (now() - kickoff)) / 60))::int
    when extract(epoch from (now() - kickoff)) / 60 <= 60 then 45
    else least(90, floor(extract(epoch from (now() - kickoff)) / 60 - 15))::int
  end;
$$;

-- ── 2. Match multiplier computation ────────────────────────────────────
-- Given a match + a prediction, returns the net-profit multiplier the
-- server will pay out at. For live matches, recomputes odds against the
-- remaining time + current score (mirrors computeLiveOdds in TS).

create or replace function public.compute_bet_multiplier(
  p_match_id uuid,
  p_prediction_type text,
  p_predicted_value text
) returns numeric language plpgsql stable as $$
declare
  m record;
  cur_home integer;
  cur_away integer;
  is_live boolean;
  mins_remaining integer;
  rem_frac numeric;
  home_rem numeric;
  away_rem numeric;
  p_home numeric := 0;
  p_draw numeric := 0;
  p_away numeric := 0;
  p_yes  numeric;
  ph numeric;
  pa numeric;
  h integer;
  a integer;
  total numeric;
  picked_h integer;
  picked_a integer;
  d_odds numeric;
begin
  select * into m from public.matches where id = p_match_id;
  if not found then raise exception 'match not found'; end if;
  if m.home_odds is null or m.expected_home_goals is null then
    raise exception 'odds not ready for this match';
  end if;

  is_live := (m.status = 'live');
  cur_home := coalesce(m.home_score, 0);
  cur_away := coalesce(m.away_score, 0);

  -- Pre-match: trust the stored odds (already computed at sync time from
  -- standings or WC nation strength).
  if not is_live then
    if p_prediction_type = 'result' then
      if    p_predicted_value = '1' then d_odds := m.home_odds;
      elsif p_predicted_value = 'X' then d_odds := m.draw_odds;
      elsif p_predicted_value = '2' then d_odds := m.away_odds;
      else raise exception 'invalid result pick %', p_predicted_value;
      end if;
    elsif p_prediction_type = 'btts' then
      if    p_predicted_value = 'yes' then d_odds := m.btts_yes_odds;
      elsif p_predicted_value = 'no'  then d_odds := m.btts_no_odds;
      else raise exception 'invalid btts pick %', p_predicted_value;
      end if;
    elsif p_prediction_type = 'exact_score' then
      picked_h := split_part(p_predicted_value, '-', 1)::int;
      picked_a := split_part(p_predicted_value, '-', 2)::int;
      d_odds := public.exact_score_decimal(m.expected_home_goals, m.expected_away_goals, picked_h, picked_a, 0, 0);
    else
      raise exception 'invalid prediction_type %', p_prediction_type;
    end if;
    return public.decimal_to_mult(d_odds);
  end if;

  -- Live: recompute 1X2 / BTTS against goals remaining in the match.
  -- Stoppage floor of 4 mins matches STOPPAGE_FLOOR_MINS in computeLiveOdds.
  mins_remaining := greatest(4, 90 - public.live_minute(m.kickoff_at));
  rem_frac := least(1, mins_remaining::numeric / 90);
  home_rem := m.expected_home_goals * rem_frac;
  away_rem := m.expected_away_goals * rem_frac;

  if p_prediction_type = 'result' then
    for h in 0..9 loop
      ph := public.poisson_pmf(home_rem, h);
      for a in 0..9 loop
        pa := public.poisson_pmf(away_rem, a);
        if    (cur_home + h) > (cur_away + a) then p_home := p_home + ph * pa;
        elsif (cur_home + h) = (cur_away + a) then p_draw := p_draw + ph * pa;
        else p_away := p_away + ph * pa;
        end if;
      end loop;
    end loop;
    total := p_home + p_draw + p_away;
    if total > 0 then p_home := p_home/total; p_draw := p_draw/total; p_away := p_away/total; end if;
    if    p_predicted_value = '1' then d_odds := public.prob_to_decimal(p_home);
    elsif p_predicted_value = 'X' then d_odds := public.prob_to_decimal(p_draw);
    elsif p_predicted_value = '2' then d_odds := public.prob_to_decimal(p_away);
    else raise exception 'invalid result pick %', p_predicted_value; end if;
    return public.decimal_to_mult(d_odds);
  end if;

  if p_prediction_type = 'btts' then
    -- A team that already scored is locked in as "yes". Otherwise needs ≥1
    -- in the remaining time → 1 − P(0 goals).
    p_yes := (case when cur_home > 0 then 1 else (1 - public.poisson_pmf(home_rem, 0)) end)
           * (case when cur_away > 0 then 1 else (1 - public.poisson_pmf(away_rem, 0)) end);
    if    p_predicted_value = 'yes' then d_odds := public.prob_to_decimal(p_yes);
    elsif p_predicted_value = 'no'  then d_odds := public.prob_to_decimal(1 - p_yes);
    else raise exception 'invalid btts pick %', p_predicted_value; end if;
    return public.decimal_to_mult(d_odds);
  end if;

  if p_prediction_type = 'exact_score' then
    picked_h := split_part(p_predicted_value, '-', 1)::int;
    picked_a := split_part(p_predicted_value, '-', 2)::int;
    -- expected_FINAL_goals = current + remaining (matches computeLiveOdds output)
    d_odds := public.exact_score_decimal(cur_home + home_rem, cur_away + away_rem, picked_h, picked_a, cur_home, cur_away);
    return public.decimal_to_mult(d_odds);
  end if;

  raise exception 'invalid prediction_type %', p_prediction_type;
end;
$$;

-- ── 3. place_bet RPC — the ONLY way to insert a prediction ────────────

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
  v_existing_total integer;
  v_existing_dbl integer;
  v_mult numeric;
  v_risk text;
  v_inserted public.predictions;
  BET_WINDOW_MINS constant integer := 180;  -- mirrors BET_WINDOW_MS = 3h in modal
begin
  if v_user is null then raise exception 'not authenticated'; end if;

  -- Membership check
  if not exists (
    select 1 from public.league_members
    where league_id = p_league_id and user_id = v_user
  ) then
    raise exception 'not a member of this league';
  end if;

  -- Wager bounds (matches predictions.points_wagered CHECK constraint)
  if p_points_wagered < 10 or p_points_wagered > 100 then
    raise exception 'points_wagered must be between 10 and 100';
  end if;

  -- Match state
  select * into v_match from public.matches where id = p_match_id;
  if not found then raise exception 'match not found'; end if;
  if v_match.status = 'finished' or v_match.status = 'postponed' then
    raise exception 'match is no longer bettable';
  end if;

  -- 3h pre-kickoff window. Live matches bypass this check (in-play bets).
  if v_match.status = 'scheduled' then
    v_mins_to_kickoff := extract(epoch from (v_match.kickoff_at - now())) / 60;
    if v_mins_to_kickoff <= 0 then
      raise exception 'match has started — wait for the live row to flip';
    end if;
    if v_mins_to_kickoff > BET_WINDOW_MINS then
      raise exception 'bets open % min before kickoff', BET_WINDOW_MINS;
    end if;
  end if;

  -- Budget: sum of all wagered points (matches frontend pointsUsed calc)
  select coalesce(sum(points_wagered), 0) into v_existing_total
  from public.predictions
  where user_id = v_user and league_id = p_league_id;
  if v_existing_total + p_points_wagered > 100 then
    raise exception 'matchday budget exceeded (% / 100)', v_existing_total;
  end if;

  -- Double-or-nothing: one per league (matches hasUsedDoubleOrNothing)
  if p_double_or_nothing then
    select count(*) into v_existing_dbl
    from public.predictions
    where user_id = v_user and league_id = p_league_id and double_or_nothing = true;
    if v_existing_dbl > 0 then
      raise exception 'double-or-nothing already used in this league';
    end if;
  end if;

  -- Live impossible-pick gating
  if v_match.status = 'live' then
    if p_prediction_type = 'btts' and p_predicted_value = 'no'
       and coalesce(v_match.home_score, 0) > 0
       and coalesce(v_match.away_score, 0) > 0 then
      raise exception 'BTTS No is impossible — both teams have scored';
    end if;
    if p_prediction_type = 'exact_score' then
      if split_part(p_predicted_value, '-', 1)::int < coalesce(v_match.home_score, 0)
         or split_part(p_predicted_value, '-', 2)::int < coalesce(v_match.away_score, 0) then
        raise exception 'exact score below current scoreline is impossible';
      end if;
    end if;
  end if;

  -- Server-recomputed multiplier — the client value is ignored.
  v_mult := public.compute_bet_multiplier(p_match_id, p_prediction_type, p_predicted_value);

  -- Risk tier from multiplier (mirrors oddsToRiskTier)
  v_risk := case
    when v_mult < 1.0 then 'low'
    when v_mult < 3.0 then 'medium'
    else 'high'
  end;

  -- The UNIQUE(user_id, match_id, league_id, prediction_type) constraint
  -- enforces one-shot at the DB level — any retry raises 23505.
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

-- Let authenticated users call it; the RPC checks auth.uid() internally.
grant execute on function public.place_bet(uuid, uuid, text, text, integer, boolean) to authenticated;

-- ── 4. Lock down matches: clients can no longer tamper with scores ─────
-- The cron and the new /api/sync/matches endpoint use the service role
-- which bypasses RLS, so they continue to work.

drop policy if exists "Authenticated users can insert matches" on public.matches;
drop policy if exists "Authenticated users can update matches" on public.matches;
-- SELECT policy ("Anyone can view matches") is intentionally kept.

-- ── 5. Lock down predictions: bets are truly one-shot ─────────────────
-- The frontend already treats them as immutable, but the policy still
-- permitted updates from anyone with the row's user_id. resolve_predictions
-- runs as SECURITY DEFINER so it bypasses RLS and can still flip
-- resolved/points_won.

drop policy if exists "Users can update their own unresolved predictions" on public.predictions;

-- ── 6. Strip the place_bet path from direct insert as well ─────────────
-- We DROP the old insert policy so the only way in is via the RPC.
drop policy if exists "Users can create their own predictions" on public.predictions;
-- (RPC runs SECURITY DEFINER → bypasses RLS for its insert.)

-- ── 7. Fix the NULLIF(odds_multiplier, 1) legacy-detection bug ─────────
-- The old detection misread a legitimately-computed 1.00 multiplier as a
-- legacy row. With the RPC always storing real values, drop the detection
-- and trust the column directly. Legacy rows are backfilled below.

create or replace function public.resolve_predictions(p_match_id uuid)
returns void language plpgsql security definer as $$
declare
  v_match record;
  v_pred  record;
  v_correct boolean;
  v_mult numeric;
  v_points integer;
  v_actual_result text;
begin
  select * into v_match from public.matches where id = p_match_id;
  if v_match.status <> 'finished' then return; end if;

  if    v_match.home_score > v_match.away_score then v_actual_result := '1';
  elsif v_match.home_score = v_match.away_score then v_actual_result := 'X';
  else                                               v_actual_result := '2';
  end if;

  for v_pred in
    select * from public.predictions
    where match_id = p_match_id and resolved = false
  loop
    v_correct := false;
    case v_pred.prediction_type
      when 'result' then
        v_correct := (v_pred.predicted_value = v_actual_result);
      when 'exact_score' then
        v_correct := (v_pred.predicted_value =
          v_match.home_score::text || '-' || v_match.away_score::text);
      when 'btts' then
        v_correct := (
          (v_pred.predicted_value = 'yes' and v_match.home_score > 0 and v_match.away_score > 0) or
          (v_pred.predicted_value = 'no'  and (v_match.home_score = 0 or v_match.away_score = 0))
        );
    end case;

    -- New scheme: odds_multiplier is the source of truth, set at bet time
    -- by place_bet. No more NULLIF guessing.
    v_mult := v_pred.odds_multiplier;
    if v_pred.double_or_nothing then v_mult := v_mult * 2; end if;

    if v_correct then
      v_points := round(v_pred.points_wagered * v_mult)::integer;
    else
      v_points := -(v_pred.points_wagered * (case when v_pred.double_or_nothing then 2 else 1 end));
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

-- ── 8. Backfill legacy unresolved rows ────────────────────────────────
-- Rows inserted before this migration may have odds_multiplier = 1 (the
-- old default) regardless of bet type. Set a sensible per-type multiplier
-- so they pay out roughly correctly when they settle.
--   result      → 1.0   (≈ even money, the pre-odds default)
--   btts        → 1.0   (legacy used 2x = 1 net profit)
--   exact_score → 4.0   (legacy used 5x = 4 net profit)

update public.predictions
set odds_multiplier = case prediction_type
  when 'exact_score' then 4
  else 1
end
where resolved = false and odds_multiplier = 1;

-- ── Verify ────────────────────────────────────────────────────────────
select 'place_bet exists' as check, exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'place_bet'
) as ok
union all
select 'matches insert policy removed', not exists (
  select 1 from pg_policies
  where schemaname = 'public' and tablename = 'matches'
    and policyname = 'Authenticated users can insert matches'
)
union all
select 'predictions update policy removed', not exists (
  select 1 from pg_policies
  where schemaname = 'public' and tablename = 'predictions'
    and policyname = 'Users can update their own unresolved predictions'
);
