// netlify/functions/ping-session.js
// Lightweight endpoint to verify the user's session is still valid.
//
// Environment variables required:
//   SUPABASE_URL              – Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY – service-role key

'use strict';

const SUPABASE_URL          = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

const { authenticate } = require('./_auth.js');

async function sbPatch(path, patchBody) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method: 'PATCH',
    headers: {
      apikey:        SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      Prefer:        'return=minimal',
    },
    body: JSON.stringify(patchBody),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DB ${res.status}: ${text}`);
  }
}

exports.handler = async (event) => {
  const auth = await authenticate(event);
  if (auth.error) {
    return {
      statusCode: auth.error.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: auth.error.message }),
    };
  }

  try {
    await sbPatch(`/profiles?id=eq.${encodeURIComponent(auth.user.id)}`, {
      last_seen_at: new Date().toISOString(),
    });
  } catch (err) {
    // Keep ping endpoint non-blocking if this column is not yet migrated.
    console.warn('ping-session: failed to update last_seen_at', err.message);
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({ ok: true, id: auth.user.id }),
  };
};
