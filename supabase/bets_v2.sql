-- ──────────────────────────────────────────────────────────────────────
-- Phase 1a of the betting overhaul: generic bets + bet_legs storage.
--
-- Purpose: replace the rigid `predictions` shape (one row = one selection,
-- locked to three hardcoded market types) with a generic two-table model
-- that supports arbitrary markets AND multi-leg parlays.
--
-- This migration is PURELY ADDITIVE. The old place_bet / resolve_predictions
-- path keeps working unchanged; the new tables/RPCs sit alongside until
-- Phase 1b migrates the data and switches the application code over.
--
-- What you get here:
--   • bets table          — one row per user wager (single or parlay)
--   • bet_legs table      — one row per selection inside a bet
--   • compute_leg_decimal — server-authoritative pricer dispatcher
--                           (mirrors src/lib/markets/* in TypeScript)
--   • grade_leg           — server-authoritative grader dispatcher
--                           (mirrors MarketDef.grade in TypeScript)
--   • place_bet_v2 RPC    — the new entry point. Accepts N legs as jsonb;
--                           validates window/budget/conflicts; recomputes
--                           every odds from the matches row; inserts the
--                           bet + legs atomically.
--   • resolve_bets_for_match RPC — grades all pending legs for a finished
--                           match, settles any bet whose legs are all
--                           non-pending, applies points to league_members.
--
-- Markets supported in Phase 1a (mirroring src/lib/markets/):
--   • '1x2'         — selection: '1' | 'X' | '2'    (params: {})
--   • 'btts'        — selection: 'yes' | 'no'        (params: {})
--   • 'exact_score' — selection: 'H-A' string        (params: {})
--
-- Phase 2 will add 'ou_goals', 'double_chance', 'draw_no_bet', etc. by
-- extending the two dispatchers — no schema change required.
--
-- Run AFTER halftime_scores.sql in the SQL editor. Idempotent.
-- ──────────────────────────────────────────────────────────────────────

-- ── 1. Tables ─────────────────────────────────────────────────────────

create table if not exists public.bets (
  id                    uuid primary key default uuid_generate_v4(),
  user_id               uuid references public.users(id)   on delete cascade not null,
  league_id             uuid references public.leagues(id) on delete cascade not null,
  stake                 integer not null check (stake >= 10 and stake <= 100),
  -- Net-profit multiplier (∏ decimal_odds - 1). Frozen at bet time.
  combined_multiplier   numeric not null,
  -- round(stake * combined_multiplier). What the user wins on a clean sweep.
  potential_payout      integer not null,
  status                text default 'pending' not null
                        check (status in ('pending','won','lost','void')),
  -- Final +/- points credited to league_members on settle (null until then).
  payout                integer,
  -- Singles-only modifier; rejected for parlays in place_bet_v2.
  double_or_nothing     boolean default false not null,
  -- Optional 140-char hot take (matches existing predictions.reasoning).
  reasoning             text check (reasoning is null or char_length(reasoning) <= 140),
  created_at            timestamptz default now() not null,
  settled_at            timestamptz
);

create table if not exists public.bet_legs (
  id               uuid primary key default uuid_generate_v4(),
  bet_id           uuid references public.bets(id)    on delete cascade not null,
  match_id         uuid references public.matches(id) on delete cascade not null,
  -- Mirrors MarketType in src/lib/markets/types.ts. Extend the set when new
  -- markets land (e.g. 'ou_goals', 'double_chance' in Phase 2).
  market_type      text not null,
  -- Market-instance parameters (e.g. {"line":2.5}). '{}' for unparameterised
  -- markets. Stored as jsonb so the dispatcher can pull values cheaply.
  params           jsonb default '{}'::jsonb not null,
  -- Canonical selection key (e.g. '1','X','2','yes','no','2-1','over').
  selection        text not null,
  -- Decimal odds frozen at bet time. combined_multiplier on the parent bet
  -- is derived from the product of these.
  leg_decimal_odds numeric not null,
  leg_status       text default 'pending' not null
                   check (leg_status in ('pending','won','lost','void')),
  settled_at       timestamptz
);

create index if not exists bet_legs_bet_id_idx
  on public.bet_legs(bet_id);
-- Hot path: cron grades all pending legs for a match.
create index if not exists bet_legs_match_pending_idx
  on public.bet_legs(match_id)
  where leg_status = 'pending';
create index if not exists bets_user_league_idx
  on public.bets(user_id, league_id);

-- ── 2. Pricer dispatcher (mirrors TS market registry) ─────────────────
-- Returns the decimal odds for one (match, market_type, params, selection).
-- For live matches, defers to the same Poisson-on-remaining-time logic the
-- existing compute_bet_multiplier uses. Phase 2 adds branches here.

create or replace function public.compute_leg_decimal(
  p_match_id    uuid,
  p_market_type text,
  p_params      jsonb,
  p_selection   text
) returns numeric language plpgsql stable as $$
declare
  m record;
  is_live boolean;
  cur_home integer;
  cur_away integer;
  mins_remaining integer;
  rem_frac numeric;
  home_rem numeric;
  away_rem numeric;
  p_home numeric := 0;
  p_draw numeric := 0;
  p_away numeric := 0;
  p_yes numeric;
  ph numeric;
  pa numeric;
  h integer;
  a integer;
  total numeric;
  picked_h integer;
  picked_a integer;
begin
  select * into m from public.matches where id = p_match_id;
  if not found then raise exception 'match not found'; end if;
  if m.home_odds is null or m.expected_home_goals is null then
    raise exception 'odds not ready for this match';
  end if;

  is_live  := (m.status = 'live');
  cur_home := coalesce(m.home_score, 0);
  cur_away := coalesce(m.away_score, 0);

  -- ── 1X2 ────────────────────────────────────────────────────────────
  if p_market_type = '1x2' then
    if not is_live then
      if    p_selection = '1' then return m.home_odds;
      elsif p_selection = 'X' then return m.draw_odds;
      elsif p_selection = '2' then return m.away_odds;
      else raise exception 'invalid 1x2 selection %', p_selection;
      end if;
    end if;
    -- Live: Poisson over remaining time + locked-in current score.
    mins_remaining := greatest(4, 90 - public.live_minute(m.kickoff_at));
    rem_frac := least(1, mins_remaining::numeric / 90);
    home_rem := m.expected_home_goals * rem_frac;
    away_rem := m.expected_away_goals * rem_frac;
    for h in 0..9 loop
      ph := public.poisson_pmf(home_rem, h);
      for a in 0..9 loop
        pa := public.poisson_pmf(away_rem, a);
        if    (cur_home + h) > (cur_away + a) then p_home := p_home + ph * pa;
        elsif (cur_home + h) = (cur_away + a) then p_draw := p_draw + ph * pa;
        else  p_away := p_away + ph * pa;
        end if;
      end loop;
    end loop;
    total := p_home + p_draw + p_away;
    if total > 0 then p_home := p_home/total; p_draw := p_draw/total; p_away := p_away/total; end if;
    if    p_selection = '1' then return public.prob_to_decimal(p_home);
    elsif p_selection = 'X' then return public.prob_to_decimal(p_draw);
    elsif p_selection = '2' then return public.prob_to_decimal(p_away);
    else raise exception 'invalid 1x2 selection %', p_selection;
    end if;
  end if;

  -- ── BTTS ───────────────────────────────────────────────────────────
  if p_market_type = 'btts' then
    if not is_live then
      if    p_selection = 'yes' then return m.btts_yes_odds;
      elsif p_selection = 'no'  then return m.btts_no_odds;
      else raise exception 'invalid btts selection %', p_selection;
      end if;
    end if;
    mins_remaining := greatest(4, 90 - public.live_minute(m.kickoff_at));
    rem_frac := least(1, mins_remaining::numeric / 90);
    home_rem := m.expected_home_goals * rem_frac;
    away_rem := m.expected_away_goals * rem_frac;
    p_yes := (case when cur_home > 0 then 1 else (1 - public.poisson_pmf(home_rem, 0)) end)
           * (case when cur_away > 0 then 1 else (1 - public.poisson_pmf(away_rem, 0)) end);
    if    p_selection = 'yes' then return public.prob_to_decimal(p_yes);
    elsif p_selection = 'no'  then return public.prob_to_decimal(1 - p_yes);
    else raise exception 'invalid btts selection %', p_selection;
    end if;
  end if;

  -- ── Exact score ────────────────────────────────────────────────────
  if p_market_type = 'exact_score' then
    picked_h := split_part(p_selection, '-', 1)::int;
    picked_a := split_part(p_selection, '-', 2)::int;
    if is_live then
      mins_remaining := greatest(4, 90 - public.live_minute(m.kickoff_at));
      rem_frac := least(1, mins_remaining::numeric / 90);
      home_rem := m.expected_home_goals * rem_frac;
      away_rem := m.expected_away_goals * rem_frac;
      return public.exact_score_decimal(
        cur_home + home_rem, cur_away + away_rem,
        picked_h, picked_a, cur_home, cur_away
      );
    end if;
    return public.exact_score_decimal(
      m.expected_home_goals, m.expected_away_goals,
      picked_h, picked_a, 0, 0
    );
  end if;

  raise exception 'unknown market_type %', p_market_type;
end;
$$;

-- ── 3. Grader dispatcher (mirrors TS MarketDef.grade) ────────────────
-- Given a finished match's facts + a leg's (market_type, params, selection),
-- returns 'won' / 'lost' / 'void'. Phase 2 markets extend this.

create or replace function public.grade_leg(
  p_market_type text,
  p_params      jsonb,
  p_selection   text,
  p_home_score  integer,
  p_away_score  integer,
  p_ht_home     integer,  -- nullable; required for HT markets in Phase 2
  p_ht_away     integer
) returns text language plpgsql immutable as $$
declare
  actual_1x2 text;
  picked_h integer;
  picked_a integer;
begin
  -- ── 1X2 ────────────────────────────────────────────────────────────
  if p_market_type = '1x2' then
    actual_1x2 := case
      when p_home_score > p_away_score then '1'
      when p_home_score = p_away_score then 'X'
      else '2'
    end;
    if p_selection not in ('1','X','2') then return 'void'; end if;
    return case when p_selection = actual_1x2 then 'won' else 'lost' end;
  end if;

  -- ── BTTS ───────────────────────────────────────────────────────────
  if p_market_type = 'btts' then
    if p_selection not in ('yes','no') then return 'void'; end if;
    return case
      when (p_selection = 'yes') = (p_home_score > 0 and p_away_score > 0)
        then 'won' else 'lost'
    end;
  end if;

  -- ── Exact score ────────────────────────────────────────────────────
  if p_market_type = 'exact_score' then
    begin
      picked_h := split_part(p_selection, '-', 1)::int;
      picked_a := split_part(p_selection, '-', 2)::int;
    exception when others then
      return 'void';
    end;
    return case
      when picked_h = p_home_score and picked_a = p_away_score
        then 'won' else 'lost'
    end;
  end if;

  -- Unknown market type — void rather than crash so a stray leg doesn't
  -- block the whole bet from settling.
  return 'void';
end;
$$;

-- ── 4. place_bet_v2 — the new entry point ────────────────────────────
-- Accepts a parlay of N legs as jsonb. Singles are just len=1. All odds
-- are recomputed server-side via compute_leg_decimal; client-supplied
-- odds are ignored entirely.
--
-- Parlay rules (per user decisions):
--   • Stake counts once toward the daily 100-pt budget (not per leg).
--   • double_or_nothing and early-bird haircut apply to singles only.
--   • Legs may span different matches AND different markets on the same
--     match. Cross-leg conflict detection (e.g. 1X2='1' + dnb='2' on the
--     same match) lands in Phase 3 with a proper conflict module — for
--     now we enforce the existing "one bet per (match, market_type) per
--     league per user" rule by checking against bet_legs.
--
-- Argument shape:
--   p_legs := jsonb_build_array(
--     jsonb_build_object(
--       'match_id',    '<uuid>',
--       'market_type', '1x2',
--       'params',      '{}'::jsonb,
--       'selection',   '1'
--     ),
--     ...
--   )

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

  -- Modifier guardrails: parlays are their own thrill — no DoN, no haircut.
  if v_is_parlay and p_double_or_nothing then
    raise exception 'double-or-nothing is for single bets only';
  end if;

  -- Validate each leg + accumulate the combined decimal multiplier.
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
    -- For early-bird haircut application: only the soonest leg matters
    -- (singles have one leg; parlays don't get haircuts anyway).
    if v_min_mins_to_kickoff is null or v_mins_to_kickoff < v_min_mins_to_kickoff then
      v_min_mins_to_kickoff := v_mins_to_kickoff;
    end if;

    -- One bet per (user, league, match, market_type) — preserves the
    -- existing one-shot rule. Phase 3 will add cross-market conflict
    -- detection on top of this. Check across all non-lost bets to avoid
    -- the loophole of "lose one to try again". We check against the
    -- bet_legs table; old predictions rows are migrated in Phase 1b.
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

    -- Server-authoritative pricing. Client value is ignored.
    v_decimal := public.compute_leg_decimal(v_match_id, v_market, v_params, v_selection);
    v_product := v_product * v_decimal;
  end loop;

  -- Daily budget: stake counts once (whether single or parlay).
  select coalesce(sum(stake), 0) into v_today_total
  from public.bets
  where user_id = v_user
    and league_id = p_league_id
    and created_at >= v_day_start;
  if v_today_total + p_stake > DAILY_BUDGET then
    raise exception 'daily budget exceeded (% / % pts used today)', v_today_total, DAILY_BUDGET;
  end if;

  -- Double-or-nothing daily cap (singles only — already gated above).
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

  -- Combined net-profit multiplier: ∏(decimal) - 1, with the early-bird
  -- haircut applied to singles in the 24h..3h window.
  v_combined_mult := round((v_product - 1)::numeric, 2);
  if not v_is_parlay and v_min_mins_to_kickoff > STANDARD_WINDOW_MINS then
    v_combined_mult := round((v_combined_mult * EARLY_BIRD_FACTOR)::numeric, 2);
  end if;
  if v_combined_mult < 0.1 then v_combined_mult := 0.1; end if;

  v_potential := round(p_stake * v_combined_mult)::int;

  -- Insert the bet first so legs can reference it.
  insert into public.bets (
    user_id, league_id, stake, combined_multiplier, potential_payout,
    status, double_or_nothing, reasoning
  ) values (
    v_user, p_league_id, p_stake, v_combined_mult, v_potential,
    'pending', coalesce(p_double_or_nothing, false), v_reasoning
  )
  returning * into v_inserted;

  -- Insert legs with frozen odds. Re-price (rather than reusing v_decimal
  -- from the loop) so the per-leg decimal we persist is exact, regardless
  -- of any FP wobble from accumulating the product.
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

-- ── 5. resolve_bets_for_match — grade legs, settle finished bets ─────
-- For a finished match: grade every pending leg referencing it. Any bet
-- whose legs are all non-pending gets settled:
--   • all 'won'                 → status='won',  payout =  round(stake * (∏decimal_of_won_or_void - 1) * DoN_factor)
--                                   (void legs drop out — treated as decimal 1.0)
--   • any 'lost'                → status='lost', payout = -stake * DoN_factor
--   • all 'void'                → status='void', payout = 0 (stake returned implicitly)
--
-- Atomically updates league_members.total_points so the leaderboard moves.

create or replace function public.resolve_bets_for_match(p_match_id uuid)
returns void language plpgsql security definer as $$
declare
  m record;
  v_leg record;
  v_bet record;
  v_leg_status text;
  v_any_pending integer;
  v_any_lost integer;
  v_all_void integer;
  v_product numeric;
  v_won_payout integer;
  v_loss_payout integer;
  v_don_factor integer;
  v_final_status text;
  v_final_payout integer;
begin
  select * into m from public.matches where id = p_match_id;
  if not found or m.status <> 'finished' then return; end if;

  -- 1. Grade every pending leg for this match.
  for v_leg in
    select bl.* from public.bet_legs bl
    where bl.match_id = p_match_id and bl.leg_status = 'pending'
  loop
    v_leg_status := public.grade_leg(
      v_leg.market_type, v_leg.params, v_leg.selection,
      m.home_score, m.away_score, m.ht_home_score, m.ht_away_score
    );
    update public.bet_legs
       set leg_status = v_leg_status, settled_at = now()
     where id = v_leg.id;
  end loop;

  -- 2. Settle any bet whose legs are all non-pending. We pick up every
  --    bet touched by the match — including parlays where this is the
  --    last pending leg — and re-evaluate from scratch.
  for v_bet in
    select distinct b.*
    from public.bets b
    join public.bet_legs bl on bl.bet_id = b.id
    where bl.match_id = p_match_id
      and b.status = 'pending'
  loop
    select count(*) filter (where leg_status = 'pending') into v_any_pending
    from public.bet_legs where bet_id = v_bet.id;
    if v_any_pending > 0 then
      continue;  -- parlay still has legs in flight
    end if;

    select count(*) filter (where leg_status = 'lost') into v_any_lost
    from public.bet_legs where bet_id = v_bet.id;

    select count(*) filter (where leg_status <> 'void') into v_all_void
    from public.bet_legs where bet_id = v_bet.id;

    v_don_factor := case when v_bet.double_or_nothing then 2 else 1 end;

    if v_any_lost > 0 then
      v_final_status := 'lost';
      v_final_payout := -v_bet.stake * v_don_factor;

    elsif v_all_void = 0 then
      -- Every leg voided — stake refund.
      v_final_status := 'void';
      v_final_payout := 0;

    else
      -- All legs won or void. Recompute the combined multiplier using
      -- ONLY non-void legs (void legs drop out as decimal=1.0). This
      -- protects single-leg bets whose only leg voided from being
      -- mispaid, and gives parlays a fair partial settlement.
      select coalesce(exp(sum(ln(leg_decimal_odds))), 1) into v_product
      from public.bet_legs
      where bet_id = v_bet.id and leg_status = 'won';
      v_won_payout := round(v_bet.stake * greatest(0, v_product - 1))::int * v_don_factor;
      v_final_status := 'won';
      v_final_payout := v_won_payout;
    end if;

    update public.bets
       set status = v_final_status,
           payout = v_final_payout,
           settled_at = now()
     where id = v_bet.id;

    update public.league_members
       set total_points = total_points + v_final_payout
     where league_id = v_bet.league_id and user_id = v_bet.user_id;
  end loop;
end;
$$;

-- ── 6. Row-level security ────────────────────────────────────────────
-- Mirrors the predictions policies: league members read; only place_bet_v2
-- (security definer) writes. No UPDATE policy — bets are immutable from
-- the client side.

alter table public.bets     enable row level security;
alter table public.bet_legs enable row level security;

drop policy if exists "League members can view bets"     on public.bets;
drop policy if exists "League members can view bet legs" on public.bet_legs;
drop policy if exists "Block direct bet writes"          on public.bets;
drop policy if exists "Block direct bet leg writes"      on public.bet_legs;

create policy "League members can view bets"
  on public.bets for select
  using (public.is_league_member(league_id));

create policy "League members can view bet legs"
  on public.bet_legs for select
  using (
    exists (
      select 1 from public.bets b
      where b.id = bet_legs.bet_id
        and public.is_league_member(b.league_id)
    )
  );

-- No INSERT / UPDATE / DELETE policies → all direct writes are denied;
-- only place_bet_v2 (SECURITY DEFINER) and resolve_bets_for_match can
-- mutate these tables.

-- ── 7. Realtime ──────────────────────────────────────────────────────

do $$ begin
  alter publication supabase_realtime add table public.bets;
exception when duplicate_object then null;
end $$;

do $$ begin
  alter publication supabase_realtime add table public.bet_legs;
exception when duplicate_object then null;
end $$;

-- ── 8. Verify ────────────────────────────────────────────────────────

select 'bets table' as check, exists (
  select 1 from information_schema.tables
  where table_schema='public' and table_name='bets'
) as ok
union all
select 'bet_legs table', exists (
  select 1 from information_schema.tables
  where table_schema='public' and table_name='bet_legs'
)
union all
select 'place_bet_v2 RPC', exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and p.proname='place_bet_v2'
)
union all
select 'resolve_bets_for_match RPC', exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and p.proname='resolve_bets_for_match'
)
union all
select 'compute_leg_decimal RPC', exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and p.proname='compute_leg_decimal'
)
union all
select 'grade_leg RPC', exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and p.proname='grade_leg'
);
