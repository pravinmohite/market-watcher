CREATE TABLE public.upstox_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  access_token text NOT NULL,
  token_type text DEFAULT 'Bearer',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.upstox_tokens ENABLE ROW LEVEL SECURITY;

-- Allow edge functions (service role) to manage tokens, no public access
CREATE POLICY "No public access to upstox_tokens" ON public.upstox_tokens FOR ALL TO anon USING (false);