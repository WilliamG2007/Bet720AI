-- ─────────────────────────────────────────────
-- TEST SCENARIOS: Simulate predictions & scoring
-- Run AFTER seed_test_data.sql and after you've created a league + account in the app.
--
-- Replace these with your actual IDs (query them below first):
-- ─────────────────────────────────────────────

-- STEP 1: Find your user ID and league info
SELECT id, username FROM public.users;
SELECT id, name, invite_code FROM public.leagues;
SELECT id, user_id, league_id FROM public.league_members;

-- STEP 2: Get the test match IDs we need
SELECT id, external_id, home_team || ' vs ' || away_team AS match, status
FROM public.matches WHERE external_id >= 9000001 ORDER BY kickoff_at;

-- ─────────────────────────────────────────────
-- SCENARIO A: Place predictions on upcoming matches
-- (Simulates what happens in the UI — swap in real IDs from above)
-- ─────────────────────────────────────────────

-- Replace <USER_ID>, <LEAGUE_ID>, <MATCH_ID_ARSENAL_MANCITY> with real values
/*
INSERT INTO public.predictions
  (user_id, match_id, league_id, prediction_type, predicted_value, risk_tier, points_wagered, double_or_nothing)
VALUES
  -- Bet 1: Arsenal to win (result, low risk, x1)
  ('<USER_ID>', '<MATCH_ID_ARSENAL_MANCITY>', '<LEAGUE_ID>', 'result',      '1',   'low',    30, false),
  -- Bet 2: Exact score 2-1 (high risk, x5)
  ('<USER_ID>', '<MATCH_ID_LIVERPOOL_CHELSEA>', '<LEAGUE_ID>', 'exact_score', '2-1', 'high',   20, false),
  -- Bet 3: BTTS yes (medium risk, x2) with double-or-nothing
  ('<USER_ID>', '<MATCH_ID_REAL_BARCA>', '<LEAGUE_ID>', 'btts',        'yes', 'medium', 50, true);
*/

-- ─────────────────────────────────────────────
-- SCENARIO B: Resolve a finished match and see point changes
-- Uses the Juventus 2-1 vs Napoli match (external_id 9000008)
-- ─────────────────────────────────────────────

-- First check what match ID it got
-- SELECT id FROM public.matches WHERE external_id = 9000008;

-- Then insert some predictions on that finished match (as if they were placed before)
-- and call resolve_predictions to score them:
/*
DO $$
DECLARE
  v_user_id    uuid;
  v_league_id  uuid;
  v_match_id   uuid;
BEGIN
  SELECT id INTO v_user_id   FROM public.users   LIMIT 1;
  SELECT id INTO v_league_id FROM public.leagues LIMIT 1;
  SELECT id INTO v_match_id  FROM public.matches WHERE external_id = 9000008;

  -- Insert test predictions (ignore conflicts if already exist)
  INSERT INTO public.predictions
    (user_id, match_id, league_id, prediction_type, predicted_value, risk_tier, points_wagered, double_or_nothing)
  VALUES
    -- Correct: Juventus wins (result = '1'), wager 30 → win 30
    (v_user_id, v_match_id, v_league_id, 'result',      '1',   'low',    30, false),
    -- Correct: Exact score 2-1, wager 20 → win 100 (x5)
    (v_user_id, v_match_id, v_league_id, 'exact_score', '2-1', 'high',   20, false),
    -- Correct: BTTS yes (both scored), wager 50, double-or-nothing → win 200 (x2 x2)
    (v_user_id, v_match_id, v_league_id, 'btts',        'yes', 'medium', 50, true)
  ON CONFLICT (user_id, match_id, league_id, prediction_type) DO NOTHING;

  -- Now resolve: Juventus 2-1 Napoli
  -- Expected: result '1' ✓, exact_score '2-1' ✓, btts 'yes' ✓ (2>0 and 1>0)
  PERFORM public.resolve_predictions(v_match_id);

  RAISE NOTICE 'Done — check predictions and league_members tables';
END $$;
*/

-- ─────────────────────────────────────────────
-- SCENARIO C: Verify points after resolution
-- ─────────────────────────────────────────────
SELECT
  p.prediction_type,
  p.predicted_value,
  p.points_wagered,
  p.double_or_nothing,
  p.resolved,
  p.points_won,
  CASE WHEN p.points_won > 0 THEN 'WIN' WHEN p.points_won < 0 THEN 'LOSS' ELSE 'PENDING' END AS result
FROM public.predictions p
JOIN public.matches m ON m.id = p.match_id
WHERE m.external_id = 9000008
ORDER BY p.prediction_type;

-- Check updated league member points
SELECT lm.total_points, u.username
FROM public.league_members lm
JOIN public.users u ON u.id = lm.user_id
ORDER BY lm.total_points DESC;

-- ─────────────────────────────────────────────
-- SCENARIO D: Draw scenario - Atletico 0-0 Sevilla (external_id 9000009)
-- result '1' WRONG (-wager), result 'X' CORRECT, btts 'no' CORRECT
-- ─────────────────────────────────────────────
/*
DO $$
DECLARE
  v_user_id    uuid;
  v_league_id  uuid;
  v_match_id   uuid;
BEGIN
  SELECT id INTO v_user_id   FROM public.users   LIMIT 1;
  SELECT id INTO v_league_id FROM public.leagues LIMIT 1;
  SELECT id INTO v_match_id  FROM public.matches WHERE external_id = 9000009;

  INSERT INTO public.predictions
    (user_id, match_id, league_id, prediction_type, predicted_value, risk_tier, points_wagered, double_or_nothing)
  VALUES
    (v_user_id, v_match_id, v_league_id, 'result', 'X', 'low', 30, false),  -- CORRECT, draw
    (v_user_id, v_match_id, v_league_id, 'btts',   'no', 'medium', 20, false) -- CORRECT, 0-0
  ON CONFLICT DO NOTHING;

  PERFORM public.resolve_predictions(v_match_id);
END $$;
*/

-- ─────────────────────────────────────────────
-- CLEANUP: Remove test data if needed
-- ─────────────────────────────────────────────
/*
DELETE FROM public.predictions WHERE match_id IN (
  SELECT id FROM public.matches WHERE external_id >= 9000001
);
DELETE FROM public.matches WHERE external_id >= 9000001;
*/
