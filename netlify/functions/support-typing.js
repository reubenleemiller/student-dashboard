'use strict';

const SUPABASE_URL          = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_EMAIL           = process.env.ADMIN_EMAIL || 'reuben.miller@rmtutoringservices.com';

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

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method Not Allowed' });
  }

  const auth = await authenticate(event);
  if (auth.error) {
    return json(auth.error.status, { error: auth.error.message });
  }

  const { user, profile } = auth;
  const isAdmin = profile?.role === 'admin' || user.email === ADMIN_EMAIL;
  if (!isAdmin) {
    return json(403, { error: 'Forbidden' });
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { conversation_id, typing } = body;
  if (!conversation_id) {
    return json(400, { error: '"conversation_id" is required' });
  }

  try {
    await sbPatch(
      `/support_conversations?id=eq.${encodeURIComponent(conversation_id)}`,
      { admin_typing_at: typing === false ? null : new Date().toISOString() }
    );
  } catch (err) {
    console.warn('support-typing patch error:', err.message);
  }

  return json(200, { ok: true });
};
