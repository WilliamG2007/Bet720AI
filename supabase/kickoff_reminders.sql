-- ──────────────────────────────────────────────────────────────────────
-- MIGRATION: Kickoff reminders + extra notification types
--
-- Adds a 'bet_starting' notification fired ~10-15 min before kickoff for
-- any user with an unresolved bet on the match. Idempotent: tracked via
-- a per-prediction `reminder_sent_at` column so each bet fires once.
--
-- Also widens the notifications.type CHECK to include:
--   * bet_starting       — your bet kicks off soon
--   * achievement_earned — see achievements.sql migration
--
-- Run AFTER supabase/notifications.sql. Idempotent.
-- ──────────────────────────────────────────────────────────────────────

-- ── Widen notifications type check ───────────────────────────────────
alter table public.notifications
  drop constraint if exists notifications_type_check;
alter table public.notifications
  add constraint notifications_type_check
  check (type in (
    'bet_settled',
    'rival_bet',
    'league_join',
    'bet_starting',
    'achievement_earned'
  ));

-- ── Track per-prediction reminder state ──────────────────────────────
alter table public.predictions
  add column if not exists reminder_sent_at timestamptz;

create index if not exists predictions_unsent_reminders_idx
  on public.predictions (match_id)
  where reminder_sent_at is null and resolved = false;

-- ── RPC: send_kickoff_reminders ──────────────────────────────────────
-- Called from /api/cron/sync every 5 minutes. Finds predictions whose
-- match kicks off in 10-20 min, inserts one bet_starting notification
-- each, then stamps reminder_sent_at to prevent dup-fires.
--
-- Window edges:
--   * 20 min upper bound is wider than the 5-min cron tick so a late
--     cron run still catches the bet
--   * 10 min lower bound keeps the alert feeling timely
create or replace function public.send_kickoff_reminders()
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_count integer := 0;
begin
  with eligible as (
    select p.id, p.user_id, p.match_id, p.predicted_value, p.prediction_type,
           p.points_wagered, m.home_team, m.away_team, m.kickoff_at
    from public.predictions p
    join public.matches m on m.id = p.match_id
    where p.reminder_sent_at is null
      and p.resolved = false
      and m.status = 'scheduled'
      and m.kickoff_at > now() + interval '10 minutes'
      and m.kickoff_at < now() + interval '20 minutes'
  ),
  inserted as (
    insert into public.notifications (user_id, type, payload)
    select
      e.user_id,
      'bet_starting',
      jsonb_build_object(
        'prediction_id', e.id,
        'match_id',      e.match_id,
        'home_team',     e.home_team,
        'away_team',     e.away_team,
        'kickoff_at',    e.kickoff_at,
        'predicted',     e.predicted_value,
        'type',          e.prediction_type,
        'points',        e.points_wagered
      )
    from eligible e
    returning 1
  ),
  stamp as (
    update public.predictions set reminder_sent_at = now()
    where id in (select id from eligible)
    returning 1
  )
  select count(*) into v_count from inserted;

  return v_count;
end;
$$;

-- Cron endpoint hits this via service role — no client grant needed.

-- ── Verify ───────────────────────────────────────────────────────────
select 'reminder_sent_at column' as check, exists (
  select 1 from information_schema.columns
  where table_schema = 'public' and table_name = 'predictions'
    and column_name = 'reminder_sent_at'
) as ok
union all
select 'send_kickoff_reminders fn', exists (
  select 1 from pg_proc where proname = 'send_kickoff_reminders'
)
union all
select 'bet_starting type allowed', exists (
  select 1 from pg_constraint
  where conname = 'notifications_type_check'
);
