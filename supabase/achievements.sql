-- ──────────────────────────────────────────────────────────────────────
-- MIGRATION: Achievements / badges
--
-- Two tables: a static `achievements` catalogue (seeded below) and a
-- per-user `user_achievements` ledger of unlocks. A single SECURITY
-- DEFINER function `award_achievements_for(user_id)` is the only writer
-- and is fired by triggers on predictions / league_members / leagues.
--
-- Each new unlock inserts a row into `notifications` so the bell + feed
-- both surface it without any extra plumbing.
--
-- Run AFTER supabase/notifications.sql AND supabase/kickoff_reminders.sql
-- (the latter widens the notifications type CHECK to include
-- 'achievement_earned'). Idempotent.
-- ──────────────────────────────────────────────────────────────────────

-- ── Catalogue ────────────────────────────────────────────────────────
create table if not exists public.achievements (
  id          text primary key,
  title       text not null,
  description text not null,
  icon        text not null,             -- emoji
  tier        text not null check (tier in ('bronze', 'silver', 'gold', 'platinum')),
  sort_order  integer not null default 0
);

-- Public read-only — RLS off on the catalogue is fine but be explicit.
alter table public.achievements enable row level security;
drop policy if exists "Achievements are public" on public.achievements;
create policy "Achievements are public"
  on public.achievements for select using (true);

-- ── Seed ─────────────────────────────────────────────────────────────
insert into public.achievements (id, title, description, icon, tier, sort_order) values
  ('first_bet',    'Getting Started',  'Place your first prediction',           '🎲', 'bronze',   10),
  ('first_win',    'On the Board',     'Win your first prediction',             '🥉', 'bronze',   20),
  ('streak_3',     'Hot Hand',         'Win 3 predictions in a row',            '🔥', 'silver',   30),
  ('streak_5',     'On Fire',          'Win 5 predictions in a row',            '⚡', 'silver',   40),
  ('streak_10',    'Unstoppable',      'Win 10 predictions in a row',           '🌟', 'gold',     50),
  ('risk_taker',   'Risk Taker',       'Win a high-risk prediction',            '💎', 'silver',   60),
  ('perfect_score','Crystal Ball',     'Win an exact-score prediction',         '🔮', 'gold',     70),
  ('big_dipper',   'Big Dipper',       'Win a bet at 5x odds or higher',        '🚀', 'gold',     80),
  ('century',      'Centurion',        'Win 100 lifetime points',               '💯', 'silver',   90),
  ('legend',       'Legend',           'Win 500 lifetime points',               '👑', 'platinum', 100),
  ('socialite',    'Socialite',        'Join your first league',                '👥', 'bronze',   110),
  ('founder',      'Founder',          'Create your first league',              '🏛️', 'silver',  120),
  ('analyst',      'Analyst',          'Place 5 predictions with reasoning',    '📝', 'silver',   130)
on conflict (id) do update set
  title       = excluded.title,
  description = excluded.description,
  icon        = excluded.icon,
  tier        = excluded.tier,
  sort_order  = excluded.sort_order;

-- ── Ledger ───────────────────────────────────────────────────────────
create table if not exists public.user_achievements (
  user_id        uuid not null references public.users(id) on delete cascade,
  achievement_id text not null references public.achievements(id) on delete cascade,
  earned_at      timestamptz default now() not null,
  primary key (user_id, achievement_id)
);

create index if not exists user_achievements_user_idx
  on public.user_achievements (user_id, earned_at desc);

alter table public.user_achievements enable row level security;

-- Everyone can read everyone's badges (visible on profile cards), but
-- writes are restricted to the award function via SECURITY DEFINER.
drop policy if exists "Achievements visible to everyone" on public.user_achievements;
create policy "Achievements visible to everyone"
  on public.user_achievements for select using (true);

alter publication supabase_realtime add table public.user_achievements;

-- ── Award engine ─────────────────────────────────────────────────────
-- Idempotent: each criterion uses INSERT … ON CONFLICT DO NOTHING.
-- For each genuinely new row, fires an `achievement_earned` notification.
create or replace function public.award_achievements_for(p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_total_wins      integer;
  v_total_won_pts   integer;
  v_streak          integer;
  v_has_high_win    boolean;
  v_has_exact_win   boolean;
  v_has_big_mult    boolean;
  v_in_any_league   boolean;
  v_created_league  boolean;
  v_reasoned_count  integer;
  v_has_any_pred    boolean;
  rec               record;
begin
  -- ── Aggregate stats ─────────────────────────────────────────────────
  select count(*) > 0
    into v_has_any_pred
    from public.predictions where user_id = p_user_id;

  select coalesce(sum(case when points_won > 0 then 1 else 0 end), 0),
         coalesce(sum(case when points_won > 0 then points_won else 0 end), 0)
    into v_total_wins, v_total_won_pts
    from public.predictions
    where user_id = p_user_id and resolved = true;

  -- Streak = trailing consecutive wins among most-recent resolved bets.
  with ordered as (
    select points_won, row_number() over (order by created_at desc) as rn
    from public.predictions
    where user_id = p_user_id and resolved = true
  ),
  losses as (
    select min(rn) as first_loss from ordered where coalesce(points_won, 0) <= 0
  )
  select coalesce((select first_loss - 1 from losses), (select count(*) from ordered))
    into v_streak;

  select exists (
    select 1 from public.predictions
    where user_id = p_user_id and resolved = true and points_won > 0 and risk_tier = 'high'
  ) into v_has_high_win;

  select exists (
    select 1 from public.predictions
    where user_id = p_user_id and resolved = true and points_won > 0 and prediction_type = 'exact_score'
  ) into v_has_exact_win;

  select exists (
    select 1 from public.predictions
    where user_id = p_user_id and resolved = true and points_won > 0 and odds_multiplier >= 5
  ) into v_has_big_mult;

  select exists (
    select 1 from public.league_members where user_id = p_user_id
  ) into v_in_any_league;

  select exists (
    select 1 from public.leagues where created_by = p_user_id
  ) into v_created_league;

  select count(*) into v_reasoned_count
    from public.predictions
    where user_id = p_user_id and reasoning is not null and length(trim(reasoning)) > 0;

  -- ── Evaluate criteria → insert, capture only the new rows ───────────
  for rec in
    with claims(achievement_id, qualifies) as (values
      ('first_bet',     v_has_any_pred),
      ('first_win',     v_total_wins   >= 1),
      ('streak_3',      v_streak       >= 3),
      ('streak_5',      v_streak       >= 5),
      ('streak_10',     v_streak       >= 10),
      ('risk_taker',    v_has_high_win),
      ('perfect_score', v_has_exact_win),
      ('big_dipper',    v_has_big_mult),
      ('century',       v_total_won_pts >= 100),
      ('legend',        v_total_won_pts >= 500),
      ('socialite',     v_in_any_league),
      ('founder',       v_created_league),
      ('analyst',       v_reasoned_count >= 5)
    )
    insert into public.user_achievements (user_id, achievement_id)
    select p_user_id, c.achievement_id
    from claims c
    where c.qualifies
    on conflict (user_id, achievement_id) do nothing
    returning achievement_id
  loop
    insert into public.notifications (user_id, type, payload)
    select p_user_id, 'achievement_earned',
      jsonb_build_object(
        'achievement_id', a.id,
        'title',          a.title,
        'description',    a.description,
        'icon',           a.icon,
        'tier',           a.tier
      )
    from public.achievements a where a.id = rec.achievement_id;
  end loop;
end;
$$;

grant execute on function public.award_achievements_for(uuid) to authenticated;

-- ── Triggers ─────────────────────────────────────────────────────────
create or replace function public.tg_award_on_resolve()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (old.resolved = false and new.resolved = true) then
    perform public.award_achievements_for(new.user_id);
  end if;
  return new;
end;
$$;
drop trigger if exists trg_award_on_resolve on public.predictions;
create trigger trg_award_on_resolve
  after update on public.predictions
  for each row execute function public.tg_award_on_resolve();

create or replace function public.tg_award_on_predict()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.award_achievements_for(new.user_id);
  return new;
end;
$$;
drop trigger if exists trg_award_on_predict on public.predictions;
create trigger trg_award_on_predict
  after insert on public.predictions
  for each row execute function public.tg_award_on_predict();

create or replace function public.tg_award_on_league_join()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.award_achievements_for(new.user_id);
  return new;
end;
$$;
drop trigger if exists trg_award_on_league_join on public.league_members;
create trigger trg_award_on_league_join
  after insert on public.league_members
  for each row execute function public.tg_award_on_league_join();

create or replace function public.tg_award_on_league_create()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.award_achievements_for(new.created_by);
  return new;
end;
$$;
drop trigger if exists trg_award_on_league_create on public.leagues;
create trigger trg_award_on_league_create
  after insert on public.leagues
  for each row execute function public.tg_award_on_league_create();

-- ── Backfill existing users (idempotent) ─────────────────────────────
do $$ declare u record; begin
  for u in select id from public.users loop
    perform public.award_achievements_for(u.id);
  end loop;
end $$;

-- ── Verify ───────────────────────────────────────────────────────────
select 'achievements seeded' as check, (select count(*) from public.achievements) > 0 as ok
union all
select 'user_achievements table', exists (
  select 1 from information_schema.tables
  where table_schema = 'public' and table_name = 'user_achievements'
)
union all
select 'award function', exists (select 1 from pg_proc where proname = 'award_achievements_for');
