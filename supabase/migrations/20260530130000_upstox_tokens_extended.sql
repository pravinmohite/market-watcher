-- Store Upstox extended_token (longer read-only access) alongside daily access_token.
ALTER TABLE public.upstox_tokens
  ADD COLUMN IF NOT EXISTS extended_token text NULL,
  ADD COLUMN IF NOT EXISTS user_name text NULL,
  ADD COLUMN IF NOT EXISTS user_id text NULL;

COMMENT ON COLUMN public.upstox_tokens.extended_token IS 'Upstox extended token for read-only APIs (optional; from OAuth response).';
COMMENT ON COLUMN public.upstox_tokens.access_token IS 'Daily trading token — valid until 3:30 AM IST per Upstox; required for live orders.';
