-- ─────────────────────────────────────────────
-- TEST SEED: Realistic match data for manual testing
-- Run in Supabase SQL editor.
-- Safe to run multiple times (uses ON CONFLICT DO NOTHING / DO UPDATE).
-- ─────────────────────────────────────────────

-- ── 1. Insert test matches ───────────────────
-- Mix of: upcoming (you can bet on these), live, and finished (for resolve testing)

INSERT INTO public.matches (external_id, home_team, away_team, home_crest, away_crest, competition, kickoff_at, status, home_score, away_score, matchday, season)
VALUES
  -- UPCOMING (bettable) - 1–4 days from now
  (9000001, 'Arsenal',          'Man City',     'https://crests.football-data.org/57.png',  'https://crests.football-data.org/65.png',  'Premier League', NOW() + interval '1 day',    'scheduled', NULL, NULL, 1, '2026'),
  (9000002, 'Liverpool',        'Chelsea',      'https://crests.football-data.org/64.png',  'https://crests.football-data.org/61.png',  'Premier League', NOW() + interval '1 day 2 hours', 'scheduled', NULL, NULL, 1, '2026'),
  (9000003, 'Real Madrid',      'Barcelona',    'https://crests.football-data.org/86.png',  'https://crests.football-data.org/81.png',  'La Liga',        NOW() + interval '2 days',   'scheduled', NULL, NULL, 1, '2026'),
  (9000004, 'Bayern Munich',    'Dortmund',     'https://crests.football-data.org/5.png',   'https://crests.football-data.org/4.png',   'Bundesliga',     NOW() + interval '2 days 3 hours', 'scheduled', NULL, NULL, 1, '2026'),
  (9000005, 'PSG',              'Marseille',    'https://crests.football-data.org/524.png', 'https://crests.football-data.org/516.png', 'Ligue 1',        NOW() + interval '3 days',   'scheduled', NULL, NULL, 1, '2026'),
  (9000006, 'Inter Milan',      'AC Milan',     'https://crests.football-data.org/108.png', 'https://crests.football-data.org/98.png',  'Serie A',        NOW() + interval '4 days',   'scheduled', NULL, NULL, 1, '2026'),

  -- LIVE (visible in feed, no betting)
  (9000007, 'Tottenham',        'Man United',   'https://crests.football-data.org/73.png',  'https://crests.football-data.org/66.png',  'Premier League', NOW() - interval '1 hour',   'live',      1,    0,    1, '2026'),

  -- FINISHED (for resolve_predictions testing)
  (9000008, 'Juventus',         'Napoli',       'https://crests.football-data.org/109.png', 'https://crests.football-data.org/113.png', 'Serie A',        NOW() - interval '2 days',   'finished',  2,    1,    38, '2024'),
  (9000009, 'Atletico Madrid',  'Sevilla',      'https://crests.football-data.org/78.png',  'https://crests.football-data.org/559.png', 'La Liga',        NOW() - interval '3 days',   'finished',  0,    0,    38, '2024'),
  (9000010, 'Man City',         'West Ham',     'https://crests.football-data.org/65.png',  'https://crests.football-data.org/563.png', 'Premier League', NOW() - interval '4 days',   'finished',  3,    1,    38, '2024')

ON CONFLICT (external_id) DO UPDATE SET
  status     = EXCLUDED.status,
  home_score = EXCLUDED.home_score,
  away_score = EXCLUDED.away_score,
  updated_at = NOW();

-- ─────────────────────────────────────────────
-- VERIFICATION QUERY — check what got inserted
-- ─────────────────────────────────────────────
SELECT
  external_id,
  home_team || ' vs ' || away_team AS match,
  status,
  CASE WHEN home_score IS NOT NULL THEN home_score::text || '-' || away_score::text ELSE '—' END AS score,
  kickoff_at::date AS date
FROM public.matches
WHERE external_id >= 9000001
ORDER BY kickoff_at;
