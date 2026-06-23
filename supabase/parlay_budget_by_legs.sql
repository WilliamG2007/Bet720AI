-- ─────────────────────────────────────────────────────────────────────
-- Parlay budget rationing: each leg consumes `stake` from the daily
-- 100-pt budget, so a 3-leg parlay at 25 pts costs 75 pts of budget.
--
-- Was: stake counted once per bet (single or parlay), so a 100-pt
-- 5-leg parlay was free-riding on the budget. New rule treats every
-- leg as an independent slice of the day's allowance.
--
-- Only change vs bets_v2.sql original: the daily-budget sum now
-- multiplies stake by the leg count, and the new-bet contribution
-- becomes (p_stake * v_leg_count).
-- ─────────────────────────────────────────────────────────────────────

create or replace function public.place_bet_v2(
  p_league_id         uuid,
  p_legs              jsonb,
  p_stake             integer,
  p_double_or_nothing boolean default false,
  p_reasoning         text    default null
) returns public.bets
language plpgsql security definer set search_path = public as $$
declare
  v_user      uuid := auth.uid();
  v_leg       jsonb;
  v_match_id  uuid;
  v_market    text;
  v_params    jsonb;
  v_selection text;
  v_match     record;
  v_mins_to_kickoff numeric;
  v_min_mins_to_kickoff numeric := null;
  v_decimal   numeric;
  v_product   numeric := 1;
  v_today_total integer;
  v_today_dbl   integer;
  v_combined_mult numeric;
  v_potential   integer;
  v_inserted    public.bets;
  v_day_start   timestamptz := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
  v_reasoning   text := nullif(btrim(p_reasoning), '');
  v_leg_count   integer;
  v_is_parlay   boolean;
  STANDARD_WINDOW_MINS constant integer := 180;
  EARLY_BIRD_MINS      constant integer := 24 * 60;
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

  if p_stake < 10 or p_stake > 100 then
    raise exception 'stake must be between 10 and 100';
  end if;

  if v_reasoning is not null and length(v_reasoning) > 140 then
    raise exception 'reasoning must be 140 characters or fewer';
  end if;

  if p_legs is null or jsonb_typeof(p_legs) <> 'array' then
    raise exception 'p_legs must be a jsonb array';
  end if;
  v_leg_count := jsonb_array_length(p_legs);
  if v_leg_count < 1 then
    raise exception 'at least one leg required';
  end if;
  v_is_parlay := v_leg_count > 1;

  if v_is_parlay and p_double_or_nothing then
    raise exception 'double-or-nothing is for single bets only';
  end if;

  for v_leg in select * from jsonb_array_elements(p_legs) loop
    v_match_id  := (v_leg->>'match_id')::uuid;
    v_market    := v_leg->>'market_type';
    v_params    := coalesce(v_leg->'params', '{}'::jsonb);
    v_selection := v_leg->>'selection';
    if v_match_id is null or v_market is null or v_selection is null then
      raise exception 'leg missing required field (match_id/market_type/selection)';
    end if;

    select * into v_match from public.matches where id = v_match_id;
    if not found then raise exception 'leg references unknown match'; end if;

    if v_match.status = 'finished' or v_match.status = 'postponed' then
      raise exception 'match is no longer bettable';
    end if;
    if v_match.status = 'live' then
      raise exception 'live betting is closed';
    end if;

    v_mins_to_kickoff := extract(epoch from (v_match.kickoff_at - now())) / 60;
    if v_mins_to_kickoff <= 0 then
      raise exception 'match has started — bets are closed';
    end if;
    if v_mins_to_kickoff > EARLY_BIRD_MINS then
      raise exception 'bets open 24h before kickoff';
    end if;
    if v_min_mins_to_kickoff is null or v_mins_to_kickoff < v_min_mins_to_kickoff then
      v_min_mins_to_kickoff := v_mins_to_kickoff;
    end if;

    if exists (
      select 1
      from public.bet_legs bl
      join public.bets b on b.id = bl.bet_id
      where b.user_id = v_user
        and b.league_id = p_league_id
        and bl.match_id = v_match_id
        and bl.market_type = v_market
        and b.status in ('pending','won')
    ) then
      raise exception 'you already have a bet on this market for this match';
    end if;

    v_decimal := public.compute_leg_decimal(v_match_id, v_market, v_params, v_selection);
    v_product := v_product * v_decimal;
  end loop;

  -- Daily budget: each leg consumes `stake` from the 100-pt allowance.
  -- A 3-leg parlay at 25 pts uses 75 pts of today's budget.
  select coalesce(sum(b.stake * (
           select count(*) from public.bet_legs bl where bl.bet_id = b.id
         )), 0)::integer
    into v_today_total
  from public.bets b
  where b.user_id = v_user
    and b.league_id = p_league_id
    and b.created_at >= v_day_start;
  if v_today_total + (p_stake * v_leg_count) > DAILY_BUDGET then
    raise exception 'daily budget exceeded (% / % pts used today, this bet would add %)',
      v_today_total, DAILY_BUDGET, (p_stake * v_leg_count);
  end if;

  if p_double_or_nothing then
    select count(*) into v_today_dbl
    from public.bets
    where user_id = v_user
      and league_id = p_league_id
      and double_or_nothing = true
      and created_at >= v_day_start;
    if v_today_dbl > 0 then
      raise exception 'double-or-nothing already used today';
    end if;
  end if;

  v_combined_mult := round((v_product - 1)::numeric, 2);
  if not v_is_parlay and v_min_mins_to_kickoff > STANDARD_WINDOW_MINS then
    v_combined_mult := round((v_combined_mult * EARLY_BIRD_FACTOR)::numeric, 2);
  end if;
  if v_combined_mult < 0.1 then v_combined_mult := 0.1; end if;

  v_potential := round(p_stake * v_combined_mult)::int;

  insert into public.bets (
    user_id, league_id, stake, combined_multiplier, potential_payout,
    status, double_or_nothing, reasoning
  ) values (
    v_user, p_league_id, p_stake, v_combined_mult, v_potential,
    'pending', coalesce(p_double_or_nothing, false), v_reasoning
  )
  returning * into v_inserted;

  for v_leg in select * from jsonb_array_elements(p_legs) loop
    v_match_id  := (v_leg->>'match_id')::uuid;
    v_market    := v_leg->>'market_type';
    v_params    := coalesce(v_leg->'params', '{}'::jsonb);
    v_selection := v_leg->>'selection';
    v_decimal := public.compute_leg_decimal(v_match_id, v_market, v_params, v_selection);
    insert into public.bet_legs (bet_id, match_id, market_type, params, selection, leg_decimal_odds)
    values (v_inserted.id, v_match_id, v_market, v_params, v_selection, v_decimal);
  end loop;

  return v_inserted;
end;
$$;

grant execute on function
  public.place_bet_v2(uuid, jsonb, integer, boolean, text)
  to authenticated;
