-- Track which strategy started each session (sniper vs martingale are mutually exclusive).
ALTER TABLE public.martingale_sessions
  ADD COLUMN IF NOT EXISTS strategy_mode text NOT NULL DEFAULT 'martingale';

ALTER TABLE public.martingale_sessions
  DROP CONSTRAINT IF EXISTS martingale_sessions_strategy_mode_check;

ALTER TABLE public.martingale_sessions
  ADD CONSTRAINT martingale_sessions_strategy_mode_check
  CHECK (strategy_mode IN ('martingale', 'sniper'));

COMMENT ON COLUMN public.martingale_sessions.strategy_mode IS 'sniper = 9:35–11:00 max R2; martingale = multi-round windows';

-- Backfill sniper sessions from R1 entry tags
UPDATE public.martingale_sessions s
SET strategy_mode = 'sniper'
WHERE s.strategy_mode = 'martingale'
  AND EXISTS (
    SELECT 1
    FROM public.martingale_trades t
    WHERE t.session_id = s.id
      AND t.round = 1
      AND t.entry_reason_tag LIKE 'sniper_%'
  );
