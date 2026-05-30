import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  computeUpstoxAccessTokenExpiresAt,
  formatUpstoxExpiryIst,
  hoursUntilExpiry,
} from "./upstox-token-utils.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

async function getLatestValidToken(supabase: ReturnType<typeof createClient>) {
  const { data: token } = await supabase
    .from('upstox_tokens')
    .select('*')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return token;
}

function tokenStatusPayload(token: { expires_at: string; user_name?: string | null } | null) {
  if (!token) {
    return {
      connected: false,
      expires_at: null,
      valid_until_ist: null,
      hours_remaining: 0,
      reconnect_note:
        'Upstox live login required for actual trading. Broker tokens expire at 3:30 AM IST each day (not weekly).',
    };
  }
  const hours = hoursUntilExpiry(token.expires_at);
  return {
    connected: true,
    expires_at: token.expires_at,
    valid_until_ist: formatUpstoxExpiryIst(token.expires_at),
    hours_remaining: Math.round(hours * 10) / 10,
    user_name: token.user_name ?? null,
    reconnect_note:
      hours < 6
        ? 'Upstox access expires soon (3:30 AM IST cutoff). Reconnect after expiry for live orders.'
        : 'Upstox access is valid until 3:30 AM IST on the expiry date (Upstox daily policy). One login covers the rest of today’s session.',
  };
}

async function storeUpstoxTokens(
  supabase: ReturnType<typeof createClient>,
  row: {
    access_token: string;
    extended_token?: string | null;
    user_name?: string | null;
    user_id?: string | null;
    token_type?: string;
  },
) {
  const expiresAt = computeUpstoxAccessTokenExpiresAt();

  await supabase.from('upstox_tokens').delete().lt('expires_at', new Date().toISOString());

  const { error: insertErr } = await supabase.from('upstox_tokens').insert({
    access_token: row.access_token,
    extended_token: row.extended_token ?? null,
    user_name: row.user_name ?? null,
    user_id: row.user_id ?? null,
    token_type: row.token_type || 'Bearer',
    expires_at: expiresAt,
  });

  return { insertErr, expiresAt };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const apiKey = Deno.env.get('UPSTOX_API_KEY')!;
    const apiSecret = Deno.env.get('UPSTOX_API_SECRET')!;

    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const action = (body.action as string) || 'exchange';

    if (action === 'get-auth-url') {
      const redirectUri = (body.redirect_uri as string) || `${supabaseUrl}/functions/v1/upstox-auth`;
      const authUrl =
        `https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id=${apiKey}&redirect_uri=${encodeURIComponent(redirectUri)}`;
      return new Response(JSON.stringify({ success: true, auth_url: authUrl }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'check-token') {
      const token = await getLatestValidToken(supabase);
      return new Response(JSON.stringify({ success: true, ...tokenStatusPayload(token) }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'exchange') {
      const code = body.code as string;
      const redirectUri = body.redirect_uri as string;

      if (!code) {
        return new Response(JSON.stringify({ success: false, error: 'No auth code provided' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      console.log(`Exchanging auth code for token. Redirect URI: ${redirectUri}`);

      const tokenRes = await fetch('https://api.upstox.com/v2/login/authorization/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          code,
          client_id: apiKey,
          client_secret: apiSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }).toString(),
      });

      const tokenData = await tokenRes.json();
      console.log(`Token response status: ${tokenRes.status}`);

      if (!tokenRes.ok || !tokenData.access_token) {
        console.error('Token exchange failed:', JSON.stringify(tokenData));
        return new Response(JSON.stringify({
          success: false,
          error: tokenData.message || 'Token exchange failed',
        }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const { insertErr, expiresAt } = await storeUpstoxTokens(supabase, {
        access_token: tokenData.access_token,
        extended_token: tokenData.extended_token ?? null,
        user_name: tokenData.user_name ?? null,
        user_id: tokenData.user_id ?? null,
        token_type: tokenData.token_type || 'Bearer',
      });

      if (insertErr) {
        console.error('Failed to store token:', insertErr);
        return new Response(JSON.stringify({ success: false, error: 'Failed to store token' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      console.log(`Upstox token stored until ${formatUpstoxExpiryIst(expiresAt)} IST`);

      return new Response(JSON.stringify({
        success: true,
        message: `Upstox connected — live access until ${formatUpstoxExpiryIst(expiresAt)} IST`,
        expires_at: expiresAt,
        valid_until_ist: formatUpstoxExpiryIst(expiresAt),
        ...tokenStatusPayload({
          expires_at: expiresAt,
          user_name: tokenData.user_name,
        }),
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'save-manual-token') {
      const accessToken = body.access_token as string;
      if (!accessToken) {
        return new Response(JSON.stringify({ success: false, error: 'No token provided' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const { insertErr, expiresAt } = await storeUpstoxTokens(supabase, {
        access_token: accessToken,
        token_type: 'Bearer',
      });

      if (insertErr) {
        console.error('Failed to store manual token:', insertErr);
        return new Response(JSON.stringify({ success: false, error: 'Failed to store token' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({
        success: true,
        message: `Access token saved until ${formatUpstoxExpiryIst(expiresAt)} IST`,
        expires_at: expiresAt,
        valid_until_ist: formatUpstoxExpiryIst(expiresAt),
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ success: false, error: 'Unknown action' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Upstox auth error:', error);
    return new Response(JSON.stringify({ success: false, error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
