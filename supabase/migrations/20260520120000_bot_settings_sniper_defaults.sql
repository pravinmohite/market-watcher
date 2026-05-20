-- Default bot configuration keys (UI + edge function read from bot_settings).
INSERT INTO public.bot_settings (key, value) VALUES
  ('strategy_mode', 'sniper'),
  ('profit_target_pct', '2.5'),
  ('stop_loss_pct', '1.5'),
  ('sniper_session_loss_cap', '1200'),
  ('sniper_daily_loss_limit', '3000')
ON CONFLICT (key) DO NOTHING;
