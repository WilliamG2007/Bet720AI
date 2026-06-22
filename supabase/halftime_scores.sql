-- ─────────────────────────────────────────────
-- Phase 0 of the betting overhaul: store half-time scores.
-- football-data.org's /matches feed already returns score.halfTime.{home,away}
-- — we just weren't persisting it. Unlocks halftime-result, HT/FT, first-half
-- BTTS, first/second-half totals, etc. without any new data source.
--
-- Backfill is intentionally skipped: a future cron pass will refresh in-flight
-- matches; for already-finished historical rows we'd need to re-fetch each
-- match individually (rate-limited). Run a one-off reconcile later if desired.
--
-- Safe to run multiple times.
-- ─────────────────────────────────────────────

alter table public.matches
  add column if not exists ht_home_score int,
  add column if not exists ht_away_score int;

comment on column public.matches.ht_home_score is 'Half-time goals for the home side (null when unknown). Source: football-data.org score.halfTime.home.';
comment on column public.matches.ht_away_score is 'Half-time goals for the away side (null when unknown). Source: football-data.org score.halfTime.away.';
