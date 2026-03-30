// netlify/functions/admin-delete-user.js
// Admin-only endpoint to fully delete a student account:
//   storage objects, bookings, profile row, and Supabase Auth user.
// Environment variables required:
//   SUPABASE_URL              – your Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY – service role key
//   ADMIN_EMAIL               – (optional) override the admin email address

const SUPABASE_URL          = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ADMIN_EMAIL must be set in Netlify environment variables.
// Fail fast at cold-start time if it is missing rather than silently using
// a hardcoded value, which would be a security risk in forked deployments.
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
if (!ADMIN_EMAIL) {
  throw new Error('ADMIN_EMAIL environment variable is required for admin-delete-user');
}

// ── Supabase fetch helpers (mirrors delete-account.js) ────────────────────

async function supabaseFetch(path, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'apikey':        SUPABASE_SERVICE_ROLE,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
      'Content-Type':  'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase error ${res.status}: ${body}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function supabaseAuthFetch(path, options = {}) {
  const url = `${SUPABASE_URL}/auth/v1${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'apikey':        SUPABASE_SERVICE_ROLE,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
      'Content-Type':  'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`Auth error ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function supabaseStorageFetch(path, options = {}) {
  const url = `${SUPABASE_URL}/storage/v1${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'apikey':        SUPABASE_SERVICE_ROLE,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
      'Content-Type':  'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Storage error ${res.status}: ${body}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Verify the caller's JWT and return their user record
async function verifyToken(token) {
  const data = await supabaseAuthFetch('/user', {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  return data; // { id, email, ... }
}

// List all objects under a storage prefix
async function listStorageObjects(prefix) {
  const data = await supabaseStorageFetch('/object/list/student-resources', {
    method: 'POST',
    body:   JSON.stringify({ prefix, limit: 1000, offset: 0 }),
  });
  return Array.isArray(data) ? data : [];
}

// Delete multiple storage objects by path
async function deleteStorageObjects(paths) {
  if (!paths.length) return;
  await supabaseStorageFetch('/object/student-resources', {
    method: 'DELETE',
    body:   JSON.stringify({ prefixes: paths }),
  });
}

// ── Main handler ──────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Extract admin JWT from Authorization header
  const authHeader = event.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Missing authorization token' }) };
  }

  // Verify the caller is a valid, authenticated admin
  let adminUser;
  try {
    adminUser = await verifyToken(token);
  } catch {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired token' }) };
  }

  if (adminUser.email !== ADMIN_EMAIL) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden: admin access only' }) };
  }

  // Parse request body
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { userId } = body;
  if (!userId || typeof userId !== 'string') {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing or invalid userId' }) };
  }

  // Prevent admin from accidentally deleting their own account via this endpoint
  if (userId === adminUser.id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Cannot delete your own account via this endpoint' }) };
  }

  console.log(`Admin ${adminUser.email} deleting user ${userId}`);

  try {
    // 1. Delete all storage objects under students/<userId>/
    const prefix  = `students/${userId}/`;
    const objects = await listStorageObjects(prefix);
    const paths   = objects.map(o => `${prefix}${o.name}`);
    await deleteStorageObjects(paths);

    // 2. Delete bookings for the user
    await supabaseFetch(`/bookings?user_id=eq.${userId}`, { method: 'DELETE' });

    // 3. Delete the profile row (cascade handles FK references)
    await supabaseFetch(`/profiles?id=eq.${userId}`, { method: 'DELETE' });

    // 4. Delete the Supabase Auth user (requires service role)
    await supabaseAuthFetch(`/admin/users/${userId}`, { method: 'DELETE' });

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('admin-delete-user error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
