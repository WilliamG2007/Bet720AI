-- ──────────────────────────────────────────────────────────────────────
-- MIGRATION: Notifications
--
-- One typed table + three triggers cover the most common social moments:
--
--   * bet_settled  — your bet just resolved (win/loss)
--   * rival_bet    — a leaguemate placed a bet
--   * league_join  — someone joined your league
--
-- Why not channel events through Supabase realtime alone? Realtime is
-- ephemeral — if a user is offline when their bet settles, they miss it.
-- A persistent table gives an unread bell + history.
--
-- Kickoff reminders ("your bet starts in 15 min") need a cron job —
-- saved for a later pass.
--
-- Run AFTER the previous migrations. Idempotent.
-- ──────────────────────────────────────────────────────────────────────

create table if not exists public.notifications (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid references public.users(id) on delete cascade not null,
  type        text not null check (type in ('bet_settled', 'rival_bet', 'league_join')),
  payload     jsonb not null default '{}',
  read_at     timestamptz,
  created_at  timestamptz default now() not null
);

create index if not exists notifications_user_unread_idx
  on public.notifications (user_id, created_at desc) where read_at is null;
create index if not exists notifications_user_recent_idx
  on public.notifications (user_id, created_at desc);

alter table public.notifications enable row level security;

-- A user can only see/update their own row.
drop policy if exists "Users see their notifications"   on public.notifications;
drop policy if exists "Users mark their notifications"  on public.notifications;
create policy "Users see their notifications"
  on public.notifications for select using (auth.uid() = user_id);
create policy "Users mark their notifications"
  on public.notifications for update using (auth.uid() = user_id);
-- No INSERT/DELETE policies: only the triggers (SECURITY DEFINER) write rows,
-- and we never expose deletion to clients.

alter publication supabase_realtime add table public.notifications;

-- ── TRIGGER: bet settled ──────────────────────────────────────────────
-- Fires when resolve_predictions sets resolved=true on a row.
create or replace function public.notify_bet_settled()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_match record;
begin
  if (old.resolved = false and new.resolved = true) then
    select home_team, away_team, home_score, away_score
      into v_match from public.matches where id = new.match_id;

    insert into public.notifications (user_id, type, payload) values (
      new.user_id,
      'bet_settled',
      jsonb_build_object(
        'prediction_id', new.id,
        'match_id',      new.match_id,
        'home_team',     v_match.home_team,
        'away_team',     v_match.away_team,
        'home_score',    v_match.home_score,
        'away_score',    v_match.away_score,
        'predicted',     new.predicted_value,
        'type',          new.prediction_type,
        'points_won',    new.points_won,
        'won',           (new.points_won > 0)
      )
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_notify_bet_settled on public.predictions;
create trigger trg_notify_bet_settled
  after update on public.predictions
  for each row execute function public.notify_bet_settled();

-- ── TRIGGER: rival placed a bet ──────────────────────────────────────
-- On every new prediction, notify the other members of the same league.
-- Skip self. Bulk insert keeps it cheap even in large leagues.
create or replace function public.notify_rival_bet()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_match record;
  v_username text;
begin
  select home_team, away_team into v_match
    from public.matches where id = new.match_id;
  select username into v_username
    from public.users where id = new.user_id;

  insert into public.notifications (user_id, type, payload)
  select
    lm.user_id,
    'rival_bet',
    jsonb_build_object(
      'prediction_id', new.id,
      'match_id',      new.match_id,
      'league_id',     new.league_id,
      'actor_id',      new.user_id,
      'actor_name',    v_username,
      'home_team',     v_match.home_team,
      'away_team',     v_match.away_team,
      'type',          new.prediction_type,
      'predicted',     new.predicted_value,
      'points',        new.points_wagered
    )
  from public.league_members lm
  where lm.league_id = new.league_id
    and lm.user_id <> new.user_id;

  return new;
end;
$$;

drop trigger if exists trg_notify_rival_bet on public.predictions;
create trigger trg_notify_rival_bet
  after insert on public.predictions
  for each row execute function public.notify_rival_bet();

-- ── TRIGGER: league join ─────────────────────────────────────────────
-- Notify the league creator (and only the creator) when someone new
-- joins. Noisier "X joined your league, now Y members" works too but
-- creator-only keeps signal-to-noise high.
create or replace function public.notify_league_join()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_league record;
  v_username text;
begin
  select id, name, created_by into v_league from public.leagues where id = new.league_id;
  -- Don't notify the creator about themselves joining their own league
  if v_league.created_by = new.user_id then return new; end if;
  select username into v_username from public.users where id = new.user_id;

  insert into public.notifications (user_id, type, payload) values (
    v_league.created_by,
    'league_join',
    jsonb_build_object(
      'league_id',   v_league.id,
      'league_name', v_league.name,
      'joiner_id',   new.user_id,
      'joiner_name', v_username
    )
  );
  return new;
end;
$$;

drop trigger if exists trg_notify_league_join on public.league_members;
create trigger trg_notify_league_join
  after insert on public.league_members
  for each row execute function public.notify_league_join();

-- ── RPC: mark all notifications read ─────────────────────────────────
-- Saves a round-trip vs an UPDATE filtered by user_id from the client.
create or replace function public.mark_all_notifications_read()
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.notifications
  set read_at = now()
  where user_id = auth.uid() and read_at is null;
end;
$$;

grant execute on function public.mark_all_notifications_read() to authenticated;

-- ── Verify ───────────────────────────────────────────────────────────
select 'notifications table' as check, exists (
  select 1 from information_schema.tables
  where table_schema = 'public' and table_name = 'notifications'
) as ok
union all
select 'bet_settled trigger', exists (
  select 1 from pg_trigger where tgname = 'trg_notify_bet_settled'
)
union all
select 'rival_bet trigger', exists (
  select 1 from pg_trigger where tgname = 'trg_notify_rival_bet'
)
union all
select 'league_join trigger', exists (
  select 1 from pg_trigger where tgname = 'trg_notify_league_join'
);
