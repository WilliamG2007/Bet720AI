-- ─────────────────────────────────────────────
-- MIGRATION: Add stage + group columns for World Cup / tournaments
-- Run in Supabase SQL editor.
-- ─────────────────────────────────────────────

ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS stage text,
  ADD COLUMN IF NOT EXISTS "group" text;

-- Verify
SELECT column_name FROM information_schema.columns
WHERE table_name = 'matches' AND column_name IN ('stage', 'group');
