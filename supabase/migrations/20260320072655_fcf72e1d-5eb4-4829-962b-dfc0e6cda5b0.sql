
CREATE TABLE public.bot_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  value text NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.bot_settings ENABLE ROW LEVEL SECURITY;

-- Public read/write since this is a single-user bot with no auth
CREATE POLICY "Anyone can read bot_settings" ON public.bot_settings FOR SELECT TO public USING (true);
CREATE POLICY "Anyone can insert bot_settings" ON public.bot_settings FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "Anyone can update bot_settings" ON public.bot_settings FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

-- Seed defaults
INSERT INTO public.bot_settings (key, value) VALUES ('max_rounds', '5'), ('trading_mode', 'paper');
