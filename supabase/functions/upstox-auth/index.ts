import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

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

    let body: any = {};
    try { body = await req.json(); } catch {}

    const action = body.action || 'exchange';

    // Return the auth URL for the user to visit
    if (action === 'get-auth-url') {
      const redirectUri = body.redirect_uri || `${supabaseUrl}/functions/v1/upstox-auth`;
      const authUrl = `https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id=${apiKey}&redirect_uri=${encodeURIComponent(redirectUri)}`;
      return new Response(JSON.stringify({ success: true, auth_url: authUrl }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Check if we have a valid token
    if (action === 'check-token') {
      const { data: token } = await supabase
        .from('upstox_tokens')
        .select('*')
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      return new Response(JSON.stringify({
        success: true,
        connected: !!token,
        expires_at: token?.expires_at || null,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Exchange auth code for access token
    if (action === 'exchange') {
      const code = body.code;
      const redirectUri = body.redirect_uri;

      if (!code) {
        return new Response(JSON.stringify({ success: false, error: 'No auth code provided' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      console.log(`Exchanging auth code for token. Redirect URI: ${redirectUri}`);

      const tokenRes = await fetch('https://api.upstox.com/v2/login/authorization/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
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
        return new Response(JSON.stringify({ success: false, error: tokenData.message || 'Token exchange failed' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Upstox tokens are valid for the entire trading day (until ~3:30 AM next day)
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 24);

      // Delete old tokens and insert new one
      await supabase.from('upstox_tokens').delete().lt('expires_at', new Date().toISOString());

      const { error: insertErr } = await supabase.from('upstox_tokens').insert({
        access_token: tokenData.access_token,
        token_type: tokenData.token_type || 'Bearer',
        expires_at: expiresAt.toISOString(),
      });

      if (insertErr) {
        console.error('Failed to store token:', insertErr);
        return new Response(JSON.stringify({ success: false, error: 'Failed to store token' }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      console.log('Upstox token stored successfully');

      return new Response(JSON.stringify({
        success: true,
        message: 'Upstox connected successfully',
        expires_at: expiresAt.toISOString(),
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Save a manually pasted access token
    if (action === 'save-manual-token') {
      const accessToken = body.access_token;
      if (!accessToken) {
        return new Response(JSON.stringify({ success: false, error: 'No token provided' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Token valid until ~3:30 AM next day IST (approx 24h)
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 24);

      await supabase.from('upstox_tokens').delete().lt('expires_at', new Date().toISOString());

      const { error: insertErr } = await supabase.from('upstox_tokens').insert({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_at: expiresAt.toISOString(),
      });

      if (insertErr) {
        console.error('Failed to store manual token:', insertErr);
        return new Response(JSON.stringify({ success: false, error: 'Failed to store token' }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({
        success: true,
        message: 'Access token saved successfully',
        expires_at: expiresAt.toISOString(),
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ success: false, error: 'Unknown action' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Upstox auth error:', error);
    return new Response(JSON.stringify({ success: false, error: (error as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
