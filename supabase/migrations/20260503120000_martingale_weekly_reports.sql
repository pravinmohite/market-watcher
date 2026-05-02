CREATE TABLE public.martingale_weekly_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start date NOT NULL UNIQUE,
  week_end date NOT NULL,
  report jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.martingale_weekly_reports IS 'IST Mon–Sun roll-up; expert_review + segments from closed trades + tick counts.';

ALTER TABLE public.martingale_weekly_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read martingale weekly reports"
  ON public.martingale_weekly_reports FOR SELECT USING (true);
