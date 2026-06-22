-- ──────────────────────────────────────────────────────────────────────
-- Phase 2: extend the SQL market dispatchers with three new market types.
--
-- New markets (mirror src/lib/markets/*.ts exactly):
--   • 'ou_goals'       — Over/Under N.5 goals; params: {line: 0.5|1.5|…}
--   • 'double_chance'  — 1X / X2 / 12; params: {}
--   • 'draw_no_bet'    — '1' or '2'; draw → void; params: {}
--
-- This file fully replaces compute_leg_decimal and grade_leg with
-- `create or replace`, so the existing Phase 1 branches are preserved
-- verbatim and the new branches are appended.
--
-- Run AFTER bets_v2.sql. Idempotent (create or replace).
-- ──────────────────────────────────────────────────────────────────────

-- ── 1. compute_leg_decimal (pricer dispatcher) ────────────────────────

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
  -- 1X2 / double_chance / draw_no_bet shared accumulators
  p_home numeric := 0;
  p_draw numeric := 0;
  p_away numeric := 0;
  -- btts
  p_yes  numeric;
  -- Poisson inner loop
  ph     numeric;
  pa     numeric;
  h      integer;
  a      integer;
  total  numeric;
  -- exact_score
  picked_h integer;
  picked_a integer;
  -- ou_goals
  v_line         numeric;
  p_over         numeric := 0;
  v_current_total integer;
  v_total_rem    numeric;
  v_goals_needed integer;
  k              integer;
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
    mins_remaining := greatest(4, 90 - public.live_minute(m.kickoff_at));
    rem_frac := least(1, mins_remaining::numeric / 90);
    home_rem := m.expected_home_goals * rem_frac;
    away_rem := m.expected_away_goals * rem_frac;
    for h in 0..9 loop
      ph := public.poisson_pmf(home_rem, h);
      for a in 0..9 loop
        pa := ph * public.poisson_pmf(away_rem, a);
        if    (cur_home + h) > (cur_away + a) then p_home := p_home + pa;
        elsif (cur_home + h) = (cur_away + a) then p_draw := p_draw + pa;
        else  p_away := p_away + pa;
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

  -- ── Over / Under goals ─────────────────────────────────────────────
  if p_market_type = 'ou_goals' then
    v_line := coalesce((p_params->>'line')::numeric, 2.5);

    if not is_live then
      for h in 0..9 loop
        ph := public.poisson_pmf(m.expected_home_goals, h);
        for a in 0..9 loop
          if (h + a)::numeric > v_line then
            p_over := p_over + ph * public.poisson_pmf(m.expected_away_goals, a);
          end if;
        end loop;
      end loop;
      if    p_selection = 'over'  then return public.prob_to_decimal(p_over);
      elsif p_selection = 'under' then return public.prob_to_decimal(1 - p_over);
      else raise exception 'invalid ou_goals selection %', p_selection;
      end if;
    end if;

    -- Live: total remaining goals ~ Poisson(homeRem + awayRem)
    mins_remaining  := greatest(4, 90 - public.live_minute(m.kickoff_at));
    rem_frac        := least(1, mins_remaining::numeric / 90);
    home_rem        := m.expected_home_goals * rem_frac;
    away_rem        := m.expected_away_goals * rem_frac;
    v_total_rem     := home_rem + away_rem;
    v_current_total := cur_home + cur_away;

    if v_current_total::numeric > v_line then
      if    p_selection = 'over'  then return 1.01;
      elsif p_selection = 'under' then return 50.0;
      else raise exception 'invalid ou_goals selection %', p_selection;
      end if;
    end if;

    v_goals_needed := ceil(v_line - v_current_total::numeric + 0.5)::int;
    for k in v_goals_needed..18 loop
      p_over := p_over + public.poisson_pmf(v_total_rem, k);
    end loop;
    if    p_selection = 'over'  then return public.prob_to_decimal(p_over);
    elsif p_selection = 'under' then return public.prob_to_decimal(1 - p_over);
    else raise exception 'invalid ou_goals selection %', p_selection;
    end if;
  end if;

  -- ── Double Chance ──────────────────────────────────────────────────
  if p_market_type = 'double_chance' then
    if not is_live then
      for h in 0..9 loop
        ph := public.poisson_pmf(m.expected_home_goals, h);
        for a in 0..9 loop
          pa := ph * public.poisson_pmf(m.expected_away_goals, a);
          if    h > a then p_home := p_home + pa;
          elsif h = a then p_draw := p_draw + pa;
          else              p_away := p_away + pa;
          end if;
        end loop;
      end loop;
    else
      mins_remaining := greatest(4, 90 - public.live_minute(m.kickoff_at));
      rem_frac := least(1, mins_remaining::numeric / 90);
      home_rem := m.expected_home_goals * rem_frac;
      away_rem := m.expected_away_goals * rem_frac;
      for h in 0..9 loop
        ph := public.poisson_pmf(home_rem, h);
        for a in 0..9 loop
          pa := ph * public.poisson_pmf(away_rem, a);
          if    (cur_home + h) > (cur_away + a) then p_home := p_home + pa;
          elsif (cur_home + h) = (cur_away + a) then p_draw := p_draw + pa;
          else                                        p_away := p_away + pa;
          end if;
        end loop;
      end loop;
    end if;
    total := p_home + p_draw + p_away;
    if total > 0 then p_home := p_home/total; p_draw := p_draw/total; p_away := p_away/total; end if;
    if    p_selection = '1X' then return public.prob_to_decimal(p_home + p_draw);
    elsif p_selection = 'X2' then return public.prob_to_decimal(p_draw + p_away);
    elsif p_selection = '12' then return public.prob_to_decimal(p_home + p_away);
    else raise exception 'invalid double_chance selection %', p_selection;
    end if;
  end if;

  -- ── Draw No Bet ────────────────────────────────────────────────────
  if p_market_type = 'draw_no_bet' then
    if not is_live then
      for h in 0..9 loop
        ph := public.poisson_pmf(m.expected_home_goals, h);
        for a in 0..9 loop
          if h = a then continue; end if; -- skip draws
          pa := ph * public.poisson_pmf(m.expected_away_goals, a);
          if h > a then p_home := p_home + pa;
          else          p_away := p_away + pa;
          end if;
        end loop;
      end loop;
    else
      mins_remaining := greatest(4, 90 - public.live_minute(m.kickoff_at));
      rem_frac := least(1, mins_remaining::numeric / 90);
      home_rem := m.expected_home_goals * rem_frac;
      away_rem := m.expected_away_goals * rem_frac;
      for h in 0..9 loop
        ph := public.poisson_pmf(home_rem, h);
        for a in 0..9 loop
          if (cur_home + h) = (cur_away + a) then continue; end if;
          pa := ph * public.poisson_pmf(away_rem, a);
          if (cur_home + h) > (cur_away + a) then p_home := p_home + pa;
          else                                     p_away := p_away + pa;
          end if;
        end loop;
      end loop;
    end if;
    total := p_home + p_away;
    if total > 0 then p_home := p_home/total; p_away := p_away/total; end if;
    if    p_selection = '1' then return public.prob_to_decimal(p_home);
    elsif p_selection = '2' then return public.prob_to_decimal(p_away);
    else raise exception 'invalid draw_no_bet selection %', p_selection;
    end if;
  end if;

  raise exception 'unknown market_type %', p_market_type;
end;
$$;

-- ── 2. grade_leg (grader dispatcher) ─────────────────────────────────

create or replace function public.grade_leg(
  p_market_type text,
  p_params      jsonb,
  p_selection   text,
  p_home_score  integer,
  p_away_score  integer,
  p_ht_home     integer,
  p_ht_away     integer
) returns text language plpgsql immutable as $$
declare
  actual_1x2 text;
  picked_h   integer;
  picked_a   integer;
  v_line     numeric;
  total      integer;
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

  -- ── Over / Under goals ─────────────────────────────────────────────
  if p_market_type = 'ou_goals' then
    v_line := coalesce((p_params->>'line')::numeric, 2.5);
    total  := p_home_score + p_away_score;
    if p_selection not in ('over','under') then return 'void'; end if;
    if p_selection = 'over'  then return case when total > v_line then 'won' else 'lost' end; end if;
    if p_selection = 'under' then return case when total < v_line then 'won' else 'lost' end; end if;
  end if;

  -- ── Double Chance ──────────────────────────────────────────────────
  if p_market_type = 'double_chance' then
    if p_selection not in ('1X','X2','12') then return 'void'; end if;
    actual_1x2 := case
      when p_home_score > p_away_score then '1'
      when p_home_score = p_away_score then 'X'
      else '2'
    end;
    return case
      when p_selection = '1X' and actual_1x2 in ('1','X') then 'won'
      when p_selection = 'X2' and actual_1x2 in ('X','2') then 'won'
      when p_selection = '12' and actual_1x2 in ('1','2') then 'won'
      else 'lost'
    end;
  end if;

  -- ── Draw No Bet ────────────────────────────────────────────────────
  if p_market_type = 'draw_no_bet' then
    if p_selection not in ('1','2') then return 'void'; end if;
    if p_home_score = p_away_score then return 'void'; end if; -- draw → refund
    actual_1x2 := case when p_home_score > p_away_score then '1' else '2' end;
    return case when p_selection = actual_1x2 then 'won' else 'lost' end;
  end if;

  -- Unknown market type — void so a stray leg doesn't block settlement.
  return 'void';
end;
$$;

-- ── 3. Verify ─────────────────────────────────────────────────────────
select 'compute_leg_decimal supports ou_goals' as check,
  public.compute_leg_decimal(
    (select id from public.matches where expected_home_goals is not null limit 1),
    'ou_goals', '{"line":2.5}'::jsonb, 'over'
  ) is not null as ok
where exists (select 1 from public.matches where expected_home_goals is not null);
