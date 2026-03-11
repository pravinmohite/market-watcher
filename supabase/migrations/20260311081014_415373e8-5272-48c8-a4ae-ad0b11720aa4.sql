-- Table to store stock alerts history
CREATE TABLE public.stock_alerts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  open_price NUMERIC NOT NULL,
  current_price NUMERIC NOT NULL,
  change_percent NUMERIC NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('up', 'down')),
  alerted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.stock_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read alerts" ON public.stock_alerts FOR SELECT USING (true);

CREATE INDEX idx_stock_alerts_symbol ON public.stock_alerts(symbol);
CREATE INDEX idx_stock_alerts_alerted_at ON public.stock_alerts(alerted_at DESC);

-- IV history table
CREATE TABLE public.stock_iv_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL,
  iv numeric NOT NULL,
  recorded_date date NOT NULL DEFAULT CURRENT_DATE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(symbol, recorded_date)
);

ALTER TABLE public.stock_iv_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read IV history" ON public.stock_iv_history FOR SELECT USING (true);

-- Martingale tables
CREATE TABLE public.martingale_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'active',
  current_round int NOT NULL DEFAULT 1,
  max_rounds int NOT NULL DEFAULT 5,
  total_pnl numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE public.martingale_trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES public.martingale_sessions(id) ON DELETE CASCADE NOT NULL,
  round int NOT NULL,
  option_type text NOT NULL,
  strike_price numeric NOT NULL,
  lots int NOT NULL DEFAULT 1,
  entry_price numeric NOT NULL,
  exit_price numeric,
  pnl numeric,
  status text NOT NULL DEFAULT 'open',
  entry_time timestamptz NOT NULL DEFAULT now(),
  exit_time timestamptz,
  nifty_spot numeric
);

ALTER TABLE public.martingale_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.martingale_trades ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read sessions" ON public.martingale_sessions FOR SELECT TO public USING (true);
CREATE POLICY "Anyone can read trades" ON public.martingale_trades FOR SELECT TO public USING (true);