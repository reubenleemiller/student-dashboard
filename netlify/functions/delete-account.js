// netlify/functions/delete-account.js
// Securely deletes a student's account: storage objects, bookings, profile, auth user.
// Environment variables required:
//   SUPABASE_URL              – your Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY – service role key

const SUPABASE_URL          = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

// Verify the user's JWT and return their uid + email
async function verifyToken(token) {
  const data = await supabaseAuthFetch('/user', {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  return data; // { id, email, ... }
}

// List all objects under a prefix in the storage bucket
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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Extract JWT from Authorization header
  const authHeader = event.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Missing authorization token' }) };
  }

  let user;
  try {
    user = await verifyToken(token);
  } catch (err) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired token' }) };
  }

  const userId = user.id;
  console.log(`Deleting account for user ${userId} (${user.email})`);

  try {
    // 1. Delete all storage objects under students/<uid>/
    const prefix = `students/${userId}/`;
    const objects = await listStorageObjects(prefix);
    const paths = objects.map(o => `${prefix}${o.name}`);
    await deleteStorageObjects(paths);

    // 2. Delete bookings
    await supabaseFetch(`/bookings?user_id=eq.${userId}`, { method: 'DELETE' });

    // 3. Delete profile (cascade handles FK references)
    await supabaseFetch(`/profiles?id=eq.${userId}`, { method: 'DELETE' });

    // 4. Delete auth user (requires service role)
    await supabaseAuthFetch(`/admin/users/${userId}`, { method: 'DELETE' });

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('delete-account error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
