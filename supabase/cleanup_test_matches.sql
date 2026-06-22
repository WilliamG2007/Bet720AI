-- ─────────────────────────────────────────────
-- CLEANUP: Remove test matches seeded by seed_test_data.sql
-- ─────────────────────────────────────────────
-- Removes the 10 fake fixtures (Arsenal–Man City, Real Madrid–Barcelona,
-- Bayern–Dortmund, etc.) that were inserted for manual testing earlier.
-- They have external_id 9000001..9000010 — well clear of any real
-- football-data.org id, so this is safe.
--
-- Cascading deletes:
--   1. Drop any predictions placed on these matches
--   2. Drop the matches themselves
--
-- Safe to run multiple times.
-- ─────────────────────────────────────────────

begin;

-- 1. Predictions on the test matches
with doomed as (
  select id from public.matches where external_id between 9000001 and 9000010
)
delete from public.predictions
where match_id in (select id from doomed);

-- 2. The test matches
delete from public.matches
where external_id between 9000001 and 9000010;

commit;

-- Verify nothing's left
select count(*) as remaining_test_matches
from public.matches
where external_id between 9000001 and 9000010;
