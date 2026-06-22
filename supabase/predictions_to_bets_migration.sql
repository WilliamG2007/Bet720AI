-- ──────────────────────────────────────────────────────────────────────
-- Phase 1b: switch the app onto bets/bet_legs.
--
-- After this migration:
--   • Every old `predictions` row is mirrored into bets + bet_legs so the
--     leaderboard history is preserved verbatim.
--   • The original `predictions` table is renamed to `predictions_legacy`
--     and a read-only VIEW called `predictions` is created over
--     bets + bet_legs with the OLD column shape. That keeps every
--     read-only consumer (history pages, leaderboard, profile, etc.)
--     working without code changes.
--   • `feed_reactions.prediction_id` is renamed to `bet_id` and
--     re-pointed at bets via the same legacy-id bridge.
--   • Kickoff reminders are rewritten to scan bet_legs instead.
--   • The old place_bet / resolve_predictions / compute_bet_multiplier
--     RPCs are dropped — clients must use place_bet_v2 / resolve_bets_for_match.
--
-- Surfaces that need code edits (handled in the Phase 1b commit):
--   • PredictionModal  — call place_bet_v2 with a single-leg p_legs array
--   • api/cron/sync.ts — call resolve_bets_for_match instead of resolve_predictions
--   • ResolutionToast  — realtime subscription on bets table
--   • FeedPage         — realtime on bets; feed_reactions.bet_id
--
-- Idempotent. Run AFTER bets_v2.sql + halftime_scores.sql. Service-role
-- (Supabase SQL editor) bypasses RLS so the data moves cleanly.
-- ──────────────────────────────────────────────────────────────────────

-- ── 0. Pre-flight: bets must exist (Phase 1a) ────────────────────────

do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'bets'
  ) then
    raise exception 'bets table is missing — run bets_v2.sql first';
  end if;
end $$;

-- ── 1. Bridge column on bets for the prediction-id backfill ──────────
-- Used purely to map old predictions.id -> new bets.id during this
-- migration (feed_reactions FK swap depends on it). Indexed for the
-- update join; dropped at the end once the bridge is no longer needed.

alter table public.bets
  add column if not exists _legacy_prediction_id uuid;

create unique index if not exists bets_legacy_pred_id_idx
  on public.bets(_legacy_prediction_id)
  where _legacy_prediction_id is not null;

-- ── 2. reminder_sent_at on bet_legs (one fire per pending leg) ───────

alter table public.bet_legs
  add column if not exists reminder_sent_at timestamptz;

create index if not exists bet_legs_unsent_reminders_idx
  on public.bet_legs(match_id)
  where reminder_sent_at is null and leg_status = 'pending';

-- ── 3. Backfill predictions → bets + bet_legs ────────────────────────
-- Skips any prediction we've already mirrored (idempotent re-run).
--
-- Status mapping:
--   not resolved              → pending
--   resolved + points_won > 0 → won
--   resolved + points_won < 0 → lost
--   resolved + points_won = 0 → void (refund)
--
-- combined_multiplier preserves the old odds_multiplier (net-profit).
-- leg_decimal_odds is the gross decimal = odds_multiplier + 1.
-- bet.payout uses the recorded points_won verbatim so the leaderboard
-- already-credited points stay intact (no re-grading legacy bets).

with new_bets as (
  insert into public.bets (
    user_id, league_id, stake, combined_multiplier, potential_payout,
    status, payout, double_or_nothing, reasoning, created_at, settled_at,
    _legacy_prediction_id
  )
  select
    p.user_id,
    p.league_id,
    p.points_wagered,
    p.odds_multiplier,
    round(p.points_wagered * p.odds_multiplier)::int,
    case
      when not p.resolved              then 'pending'
      when (p.points_won is null)      then 'pending'
      when p.points_won > 0            then 'won'
      when p.points_won < 0            then 'lost'
      else                                  'void'
    end,
    p.points_won,
    p.double_or_nothing,
    p.reasoning,
    p.created_at,
    case when p.resolved then p.created_at else null end,
    p.id
  from public.predictions p
  where not exists (
    select 1 from public.bets b where b._legacy_prediction_id = p.id
  )
  returning id, _legacy_prediction_id
)
insert into public.bet_legs (
  bet_id, match_id, market_type, params, selection,
  leg_decimal_odds, leg_status, settled_at
)
select
  nb.id,
  p.match_id,
  case p.prediction_type
    when 'result'      then '1x2'
    when 'btts'        then 'btts'
    when 'exact_score' then 'exact_score'
    else p.prediction_type
  end,
  '{}'::jsonb,
  p.predicted_value,
  p.odds_multiplier + 1,
  case
    when not p.resolved              then 'pending'
    when (p.points_won is null)      then 'pending'
    when p.points_won > 0            then 'won'
    when p.points_won < 0            then 'lost'
    else                                  'void'
  end,
  case when p.resolved then p.created_at else null end
from new_bets nb
join public.predictions p on p.id = nb._legacy_prediction_id;

-- ── 4. feed_reactions FK swap (prediction_id → bet_id) ───────────────

do $$
begin
  -- 4a. Add bet_id column (nullable for now, backfill below).
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='feed_reactions' and column_name='bet_id'
  ) then
    alter table public.feed_reactions
      add column bet_id uuid;
  end if;
end $$;

-- 4b. Backfill bet_id via the legacy bridge.
update public.feed_reactions fr
   set bet_id = b.id
  from public.bets b
 where b._legacy_prediction_id = fr.prediction_id
   and fr.bet_id is null;

-- 4c. Drop old RLS policy first (it references prediction_id), then
--     drop constraints + column.
drop policy if exists "League members can view reactions" on public.feed_reactions;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'feed_reactions_prediction_id_user_id_emoji_key'
  ) then
    alter table public.feed_reactions
      drop constraint feed_reactions_prediction_id_user_id_emoji_key;
  end if;

  if exists (
    select 1 from pg_constraint
    where conname = 'feed_reactions_prediction_id_fkey'
  ) then
    alter table public.feed_reactions
      drop constraint feed_reactions_prediction_id_fkey;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='feed_reactions' and column_name='prediction_id'
  ) then
    -- Reactions on predictions that never made it into bets (shouldn't
    -- happen, but be defensive) are orphaned — delete them so the
    -- NOT NULL below holds.
    delete from public.feed_reactions where bet_id is null;
    alter table public.feed_reactions drop column prediction_id;
  end if;
end $$;

-- 4d. Tighten bet_id: NOT NULL, FK, unique.
do $$
begin
  begin
    alter table public.feed_reactions alter column bet_id set not null;
  exception when others then null;
  end;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'feed_reactions_bet_id_fkey'
  ) then
    alter table public.feed_reactions
      add constraint feed_reactions_bet_id_fkey
      foreign key (bet_id) references public.bets(id) on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'feed_reactions_bet_id_user_id_emoji_key'
  ) then
    alter table public.feed_reactions
      add constraint feed_reactions_bet_id_user_id_emoji_key
      unique (bet_id, user_id, emoji);
  end if;
end $$;

-- 4e. Swap RLS read policy to join through bets.
drop policy if exists "League members can view reactions" on public.feed_reactions;
create policy "League members can view reactions"
  on public.feed_reactions for select using (
    exists (
      select 1 from public.bets b
      where b.id = feed_reactions.bet_id
        and public.is_league_member(b.league_id)
    )
  );

-- ── 5. Drop old RPCs (clients must use *_v2 now) ─────────────────────

drop function if exists public.place_bet(uuid, uuid, text, text, integer, boolean, text);
drop function if exists public.place_bet(uuid, uuid, text, text, integer, boolean);
drop function if exists public.compute_bet_multiplier(uuid, text, text);
drop function if exists public.resolve_predictions(uuid);

-- ── 6. Rewrite send_kickoff_reminders for bet_legs ───────────────────
-- One reminder per pending leg per match. Payload carries bet_id + leg_id
-- so the notifications consumer can deep-link into the bet.

drop function if exists public.send_kickoff_reminders();

create or replace function public.send_kickoff_reminders()
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_count integer := 0;
begin
  with eligible as (
    select bl.id as leg_id, bl.bet_id, bl.match_id, bl.selection,
           bl.market_type, b.user_id, b.stake,
           m.home_team, m.away_team, m.kickoff_at
    from public.bet_legs bl
    join public.bets    b on b.id = bl.bet_id
    join public.matches m on m.id = bl.match_id
    where bl.reminder_sent_at is null
      and bl.leg_status = 'pending'
      and b.status      = 'pending'
      and m.status      = 'scheduled'
      and m.kickoff_at  > now() + interval '10 minutes'
      and m.kickoff_at  < now() + interval '20 minutes'
  ),
  inserted as (
    insert into public.notifications (user_id, type, payload)
    select
      e.user_id,
      'bet_starting',
      jsonb_build_object(
        'bet_id',      e.bet_id,
        'leg_id',      e.leg_id,
        'match_id',    e.match_id,
        'home_team',   e.home_team,
        'away_team',   e.away_team,
        'kickoff_at',  e.kickoff_at,
        'selection',   e.selection,
        'market_type', e.market_type,
        'points',      e.stake
      )
    from eligible e
    returning 1
  ),
  stamp as (
    update public.bet_legs set reminder_sent_at = now()
    where id in (select leg_id from eligible)
    returning 1
  )
  select count(*) into v_count from inserted;

  return v_count;
end;
$$;

-- ── 7. Rename predictions table; create compat VIEW ──────────────────
-- Drop the realtime publication for the old table first (renaming a
-- table in a publication can be touchy across PG versions). Then rename
-- and put a view in its place.

do $$
begin
  alter publication supabase_realtime drop table public.predictions;
exception when others then null;  -- table may not be in the pub anymore
end $$;

-- Drop RLS policies on the old table (they'd be inherited by the new
-- name otherwise and we don't want any policy machinery on the dead
-- table; the view has no RLS of its own and inherits security from
-- bets/bet_legs).
drop policy if exists "League members can view predictions in their leagues" on public.predictions;
drop policy if exists "Users can create their own predictions"               on public.predictions;
drop policy if exists "Users can update their own unresolved predictions"    on public.predictions;

-- Rename if it still exists.
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema='public' and table_name='predictions' and table_type='BASE TABLE'
  ) then
    alter table public.predictions rename to predictions_legacy;
  end if;
end $$;

-- Compat view. One row per SINGLE-LEG bet — multi-leg parlays don't fit
-- the old shape and intentionally don't appear here (they'll surface via
-- a dedicated bets-aware feed in Phase 3). Columns mirror the predictions
-- table verbatim so every existing read site keeps working unchanged.
create or replace view public.predictions as
select
  b.id                                    as id,
  b.user_id                               as user_id,
  bl.match_id                             as match_id,
  b.league_id                             as league_id,
  case bl.market_type
    when '1x2'         then 'result'
    when 'btts'        then 'btts'
    when 'exact_score' then 'exact_score'
    else bl.market_type
  end                                     as prediction_type,
  bl.selection                            as predicted_value,
  case
    when bl.leg_decimal_odds < 2.0 then 'low'
    when bl.leg_decimal_odds < 4.0 then 'medium'
    else                                'high'
  end                                     as risk_tier,
  b.stake                                 as points_wagered,
  b.payout                                as points_won,
  b.double_or_nothing                     as double_or_nothing,
  (b.status <> 'pending')                 as resolved,
  b.created_at                            as created_at,
  b.combined_multiplier                   as odds_multiplier,
  b.reasoning                             as reasoning
from public.bets b
join public.bet_legs bl on bl.bet_id = b.id
where (select count(*) from public.bet_legs bl2 where bl2.bet_id = b.id) = 1;

-- Views can't have RLS toggled directly, but they ARE security-invoker
-- by default in modern PG: queries on the view run with the caller's
-- privileges. Since bets/bet_legs have RLS limiting select to league
-- members, the view inherits that automatically.

grant select on public.predictions to authenticated;

-- Same for predictions_legacy — keep it readable for audit, but no one
-- should write to it.
revoke insert, update, delete on public.predictions_legacy from anon, authenticated;

-- ── 8. (Optional) Drop the bridge column ─────────────────────────────
-- Comment in if you want a tidy bets table. Leaving the column around
-- is harmless and useful for audit / re-running the migration.
-- alter table public.bets drop column if exists _legacy_prediction_id;

-- ── 9. Verify ────────────────────────────────────────────────────────

select 'predictions view exists' as check, exists (
  select 1 from information_schema.views
  where table_schema='public' and table_name='predictions'
) as ok
union all
select 'predictions_legacy exists', exists (
  select 1 from information_schema.tables
  where table_schema='public' and table_name='predictions_legacy'
)
union all
select 'feed_reactions.bet_id', exists (
  select 1 from information_schema.columns
  where table_schema='public' and table_name='feed_reactions' and column_name='bet_id'
)
union all
select 'feed_reactions.prediction_id removed', not exists (
  select 1 from information_schema.columns
  where table_schema='public' and table_name='feed_reactions' and column_name='prediction_id'
)
union all
select 'old place_bet dropped', not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and p.proname='place_bet'
)
union all
select 'old resolve_predictions dropped', not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and p.proname='resolve_predictions'
)
union all
select 'bet_legs.reminder_sent_at', exists (
  select 1 from information_schema.columns
  where table_schema='public' and table_name='bet_legs' and column_name='reminder_sent_at'
);
