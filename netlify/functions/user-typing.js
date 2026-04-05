// netlify/functions/user-typing.js
// Records whether the authenticated user is currently typing in their
// active support conversation.
//
// POST body: { typing: true|false }   (defaults to true if omitted)
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
    method:  'PATCH',
    headers: {
      apikey:         SUPABASE_SERVICE_ROLE,
      Authorization:  `Bearer ${SUPABASE_SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      Prefer:         'return=minimal',
    },
    body: JSON.stringify(patchBody),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DB ${res.status}: ${text}`);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  }

  const auth = await authenticate(event);
  if (auth.error) {
    return {
      statusCode: auth.error.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: auth.error.message }),
    };
  }

  const { user } = auth;

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { /* ignore */ }

  const typing = body.typing !== false; // default true

  try {
    await sbPatch(
      `/support_conversations?user_id=eq.${user.id}&resolved=eq.false`,
      { user_typing_at: typing ? new Date().toISOString() : null }
    );
  } catch (err) {
    // Non-critical; log but return success to avoid blocking the widget
    console.warn('user-typing patch error:', err.message);
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true }),
  };
};
