// netlify/functions/admin-delete-booking.js
// Admin-only endpoint to permanently delete a cancelled, completed, or rejected booking row.
// Environment variables required:
//   SUPABASE_URL              – your Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY – service role key
//
// NOTE: Admin authorization is role-based (profiles.role === 'admin').
// Do NOT set an ADMIN_EMAIL env var (Netlify secrets scanning will flag it).

const SUPABASE_URL          = process.env.SUPABASE_URL;
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

// Verify the caller's JWT and return their user record
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
  return data; // { id, email, ... }
}

// Fetch caller's role from profiles table (service role bypasses RLS)
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

    // Extract admin JWT from Authorization header
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

    // Verify caller is admin by role
    const callerRole = await getProfileRole(caller.id);
    if (callerRole !== 'admin') {
      return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden: admin access only' }) };
    }

    // Parse request body
    let body = {};
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    const { bookingId } = body;
    if (!bookingId || typeof bookingId !== 'string') {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing or invalid bookingId' }) };
    }

    // Fetch the booking to confirm it is a cleanup-eligible status
    const rows = await supabaseFetch(
      `/bookings?id=eq.${encodeURIComponent(bookingId)}&select=id,status&limit=1`
    );

    if (!Array.isArray(rows) || !rows.length) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Booking not found' }) };
    }

    if (!['cancelled', 'completed', 'rejected'].includes(rows[0].status)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Only cancelled, completed, or rejected bookings can be deleted' }) };
    }

    console.log(`Admin ${caller.id} deleting booking ${bookingId}`);

    // Permanently delete the booking row
    await supabaseFetch(`/bookings?id=eq.${encodeURIComponent(bookingId)}`, { method: 'DELETE' });

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('admin-delete-booking error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
