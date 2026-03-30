// netlify/functions/accept-invite.js
// Marks a pending student invite as accepted for the authenticated caller.
// Called client-side after the user's first successful sign-in.
//
// Environment variables required:
//   SUPABASE_URL              – your Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY – service role key (never expose to the browser)

const SUPABASE_URL          = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL) {
  throw new Error('SUPABASE_URL environment variable is required');
}
if (!SUPABASE_SERVICE_ROLE) {
  throw new Error('SUPABASE_SERVICE_ROLE_KEY environment variable is required');
}

// Verify the caller's JWT and return their user record ({ id, email, ... })
async function verifyCallerJwt(jwt) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey:        SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${jwt}`,
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    throw new Error(`Invalid token: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }
  return data;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    // Extract user JWT from Authorization header
    const authHeader =
      event.headers?.authorization ||
      event.headers?.Authorization ||
      '';

    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Missing authorization token' }) };
    }

    // Verify caller JWT
    let caller;
    try {
      caller = await verifyCallerJwt(token);
    } catch (err) {
      return { statusCode: 401, body: JSON.stringify({ error: err.message }) };
    }

    // Validate that id is a UUID and email looks safe before embedding in URL filters.
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRe.test(caller.id)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid user id' }) };
    }
    if (!caller.email || /[(),]/.test(caller.email)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid email' }) };
    }

    // Update any pending invite for this user (matched by invited_user_id or email)
    // Using service role so this works regardless of RLS policies.
    const url = `${SUPABASE_URL}/rest/v1/student_invites` +
      `?status=eq.pending` +
      `&or=(invited_user_id.eq.${encodeURIComponent(caller.id)},email.eq.${encodeURIComponent(caller.email)})`;

    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        apikey:          SUPABASE_SERVICE_ROLE,
        Authorization:   `Bearer ${SUPABASE_SERVICE_ROLE}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=minimal',
      },
      body: JSON.stringify({
        status:           'accepted',
        accepted_at:      new Date().toISOString(),
        accepted_user_id: caller.id,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`accept-invite PATCH failed (${res.status}): ${text}`);
      return { statusCode: 500, body: JSON.stringify({ error: 'Failed to update invite' }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('accept-invite error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
