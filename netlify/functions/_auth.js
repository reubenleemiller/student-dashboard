// netlify/functions/_auth.js
// Shared authentication helpers for Netlify functions.
//
// Environment variables required:
//   SUPABASE_URL              – Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY – service-role key (never expose to browser)

'use strict';

const SUPABASE_URL          = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

/** Extract Bearer token from request headers. Returns null if absent. */
function extractToken(headers) {
  const auth = (headers?.authorization || headers?.Authorization || '');
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  return token || null;
}

/**
 * Verify a Supabase JWT and return the user record.
 * @throws {Error} if the token is invalid or expired.
 */
async function verifyToken(token) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey:        SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${token}`,
    },
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`Unauthorized (${res.status})`);
  return data; // { id, email, user_metadata, ... }
}

/**
 * Fetch a profile row by user id using the service role.
 * Returns null if not found.
 */
async function getProfile(userId) {
  const url =
    `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=*&limit=1`;
  const res = await fetch(url, {
    headers: {
      apikey:        SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
    },
  });
  const text = await res.text();
  let rows;
  try { rows = text ? JSON.parse(text) : []; } catch { rows = []; }
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/**
 * Authenticate an incoming request.
 * Returns { user, profile, token } on success,
 * or { error: { status, message } } on failure.
 */
async function authenticate(event) {
  const token = extractToken(event.headers);
  if (!token) {
    return { error: { status: 401, message: 'Missing authorization token' } };
  }
  try {
    const user    = await verifyToken(token);
    const profile = await getProfile(user.id);
    return { user, profile, token };
  } catch (err) {
    return { error: { status: 401, message: err.message } };
  }
}

module.exports = { extractToken, verifyToken, getProfile, authenticate };
