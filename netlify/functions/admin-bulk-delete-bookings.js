// netlify/functions/admin-bulk-delete-bookings.js
// Admin-only endpoint to delete cancelled, completed, and rejected bookings for one student.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL) {
  throw new Error('SUPABASE_URL environment variable is required');
}
if (!SUPABASE_SERVICE_ROLE) {
  throw new Error('SUPABASE_SERVICE_ROLE_KEY environment variable is required');
}

async function supabaseFetch(path, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    throw new Error(`Supabase error ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }
  return data;
}

async function verifyCallerJwt(jwt) {
  const url = `${SUPABASE_URL}/auth/v1/user`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${jwt}`,
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`Invalid token: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

async function getProfileRole(userId) {
  const rows = await supabaseFetch(`/profiles?id=eq.${encodeURIComponent(userId)}&select=role&limit=1`);
  if (Array.isArray(rows) && rows.length) return rows[0].role || null;
  return null;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const authHeader =
      event.headers?.authorization ||
      event.headers?.Authorization ||
      '';

    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Missing authorization token' }) };
    }

    let caller;
    try {
      caller = await verifyCallerJwt(token);
    } catch (err) {
      return { statusCode: 401, body: JSON.stringify({ error: err.message }) };
    }

    const callerRole = await getProfileRole(caller.id);
    if (callerRole !== 'admin') {
      return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden: admin access only' }) };
    }

    let body = {};
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    const { userId } = body;
    if (!userId || typeof userId !== 'string') {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing or invalid userId' }) };
    }

    const matches = await supabaseFetch(
      `/bookings?user_id=eq.${encodeURIComponent(userId)}&status=in.(cancelled,completed,rejected)&select=id`
    );
    const deletedCount = Array.isArray(matches) ? matches.length : 0;

    if (deletedCount > 0) {
      await supabaseFetch(
        `/bookings?user_id=eq.${encodeURIComponent(userId)}&status=in.(cancelled,completed,rejected)`,
        { method: 'DELETE', headers: { Prefer: 'return=minimal' } }
      );
    }

    return { statusCode: 200, body: JSON.stringify({ deletedCount }) };
  } catch (err) {
    console.error('admin-bulk-delete-bookings error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};