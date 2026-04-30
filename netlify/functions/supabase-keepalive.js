// netlify/functions/supabase-keepalive.js
// Scheduled function that keeps the Supabase project active so it is never
// paused due to inactivity.  Runs once per day via the cron schedule
// configured in netlify.toml.
//
// Environment variables required:
//   SUPABASE_URL              – Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY – service-role key

'use strict';

const SUPABASE_URL          = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

exports.handler = async () => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.error('supabase-keepalive: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    return { statusCode: 500, body: 'missing env vars' };
  }

  try {
    // Use the GoTrue health endpoint – lightweight, no table dependency.
    const res = await fetch(`${SUPABASE_URL}/auth/v1/health`, {
      headers: {
        apikey:        SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Supabase responded ${res.status}: ${text}`);
    }

    console.log('supabase-keepalive: ping successful at', new Date().toISOString());
    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error('supabase-keepalive: ping failed', err.message);
    return { statusCode: 500, body: 'keepalive failed' };
  }
};
