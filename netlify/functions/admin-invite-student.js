// netlify/functions/admin-invite-student.js
// Admin-only endpoint to invite a new student by email.
// Supabase sends the invitation email; once the user accepts, the
// handle_new_user trigger creates their profiles row automatically.
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

// Verify the caller's JWT and return their user record
async function verifyCallerJwt(jwt) {
  const url = `${SUPABASE_URL}/auth/v1/user`;
  const res = await fetch(url, {
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
  return data; // { id, email, ... }
}

// Fetch caller's role from profiles table (service role bypasses RLS)
async function getProfileRole(userId) {
  const url = `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=role&limit=1`;
  const res = await fetch(url, {
    headers: {
      apikey:        SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      'Content-Type': 'application/json',
    },
  });
  const text = await res.text();
  let rows = null;
  try { rows = text ? JSON.parse(text) : []; } catch { rows = []; }
  if (Array.isArray(rows) && rows.length) return rows[0].role || null;
  return null;
}

// Upsert a row in public.student_invites (status='pending') for the invited email.
// Uses merge-duplicates so a re-invite resets the pending record.
async function upsertStudentInvite(email, fullName, invitedBy) {
  const url = `${SUPABASE_URL}/rest/v1/student_invites`;
  const body = {
    email,
    full_name:   fullName || null,
    invited_by:  invitedBy || null,
    status:      'pending',
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey:          SUPABASE_SERVICE_ROLE,
      Authorization:   `Bearer ${SUPABASE_SERVICE_ROLE}`,
      'Content-Type':  'application/json',
      'Prefer':        'resolution=merge-duplicates',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    // Log but don't throw – invite email was already sent; this is non-critical
    console.warn(`student_invites upsert warning for ${email} (${res.status}): ${text}`);
  }
}


async function inviteUser(email, fullName) {
  const url = `${SUPABASE_URL}/auth/v1/invite`;
  const body = { email };
  if (fullName) {
    body.data = { full_name: fullName };
  }
  const res = await fetch(url, {
    method:  'POST',
    headers: {
      apikey:          SUPABASE_SERVICE_ROLE,
      Authorization:   `Bearer ${SUPABASE_SERVICE_ROLE}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    throw new Error(
      `Invite failed (${res.status}): ${typeof data === 'string' ? data : JSON.stringify(data)}`
    );
  }
  return data;
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

    const { email, fullName } = body;

    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'A valid email address is required' }) };
    }

    if (fullName !== undefined && typeof fullName !== 'string') {
      return { statusCode: 400, body: JSON.stringify({ error: 'fullName must be a string' }) };
    }

    const trimmedEmail    = email.trim().toLowerCase();
    const trimmedFullName = fullName ? fullName.trim() : '';

    console.log(`Admin ${caller.id} inviting user: ${trimmedEmail}`);

    await inviteUser(trimmedEmail, trimmedFullName || null);
    await upsertStudentInvite(trimmedEmail, trimmedFullName || null, caller.id);

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('admin-invite-student error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
