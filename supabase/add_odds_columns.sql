-- ─────────────────────────────────────────────
-- MIGRATION: Add dynamic odds columns
-- Run in Supabase SQL editor.
-- ─────────────────────────────────────────────

-- ── 1. matches: store Poisson-computed odds ──
ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS home_odds           numeric,
  ADD COLUMN IF NOT EXISTS draw_odds           numeric,
  ADD COLUMN IF NOT EXISTS away_odds           numeric,
  ADD COLUMN IF NOT EXISTS btts_yes_odds       numeric,
  ADD COLUMN IF NOT EXISTS btts_no_odds        numeric,
  ADD COLUMN IF NOT EXISTS expected_home_goals numeric,
  ADD COLUMN IF NOT EXISTS expected_away_goals numeric;

-- ── 2. predictions: store the multiplier at bet time ──
ALTER TABLE public.predictions
  ADD COLUMN IF NOT EXISTS odds_multiplier numeric NOT NULL DEFAULT 1;

-- ── 3. Update resolve_predictions to use stored odds_multiplier ──
--    Falls back to legacy fixed multipliers for old rows (odds_multiplier = 1 default).
CREATE OR REPLACE FUNCTION public.resolve_predictions(p_match_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_match   record;
  v_pred    record;
  v_correct boolean;
  v_mult    numeric;
  v_points  integer;
  v_actual_result text;
BEGIN
  SELECT * INTO v_match FROM public.matches WHERE id = p_match_id;
  IF v_match.status <> 'finished' THEN RETURN; END IF;

  IF    v_match.home_score > v_match.away_score THEN v_actual_result := '1';
  ELSIF v_match.home_score = v_match.away_score THEN v_actual_result := 'X';
  ELSE                                               v_actual_result := '2';
  END IF;

  FOR v_pred IN
    SELECT * FROM public.predictions
    WHERE match_id = p_match_id AND resolved = false
  LOOP
    v_correct := false;

    CASE v_pred.prediction_type
      WHEN 'result' THEN
        v_correct := (v_pred.predicted_value = v_actual_result);
      WHEN 'exact_score' THEN
        v_correct := (v_pred.predicted_value =
          v_match.home_score::text || '-' || v_match.away_score::text);
      WHEN 'btts' THEN
        v_correct := (
          (v_pred.predicted_value = 'yes' AND v_match.home_score > 0 AND v_match.away_score > 0) OR
          (v_pred.predicted_value = 'no'  AND (v_match.home_score = 0 OR v_match.away_score = 0))
        );
    END CASE;

    -- Use the stored per-prediction multiplier (set at bet time from real odds).
    -- Legacy rows default to 1; upgrade them with sensible fallbacks.
    v_mult := COALESCE(
      NULLIF(v_pred.odds_multiplier, 1),  -- use real multiplier if non-default
      CASE v_pred.prediction_type         -- legacy fallback
        WHEN 'result'      THEN 1
        WHEN 'btts'        THEN 1
        WHEN 'exact_score' THEN 4
      END
    );

    IF v_pred.double_or_nothing THEN
      v_mult := v_mult * 2;
    END IF;

    IF v_correct THEN
      v_points := ROUND(v_pred.points_wagered * v_mult)::integer;
    ELSE
      v_points := -(v_pred.points_wagered * (CASE WHEN v_pred.double_or_nothing THEN 2 ELSE 1 END));
    END IF;

    UPDATE public.predictions
    SET points_won = v_points, resolved = true
    WHERE id = v_pred.id;

    UPDATE public.league_members
    SET total_points = total_points + v_points
    WHERE league_id = v_pred.league_id AND user_id = v_pred.user_id;
  END LOOP;
END;
$$;

-- ── Verify ──
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name IN ('matches', 'predictions')
  AND column_name IN (
    'home_odds','draw_odds','away_odds',
    'btts_yes_odds','btts_no_odds',
    'expected_home_goals','expected_away_goals',
    'odds_multiplier'
  )
ORDER BY table_name, column_name;
