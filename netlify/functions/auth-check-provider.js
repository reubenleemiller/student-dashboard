// netlify/functions/auth-check-provider.js
// Public endpoint: given an email, returns { isGoogleOnly: boolean }.
// isGoogleOnly is true when the account exists, has a Google identity, and has
// no password-based identity set (i.e. the user signed up only via Google OAuth).
//
// Environment variables required:
//   SUPABASE_URL              – your Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY – service role key (not exposed to browser)

const SUPABASE_URL          = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL) throw new Error('SUPABASE_URL environment variable is required');
if (!SUPABASE_SERVICE_ROLE) throw new Error('SUPABASE_SERVICE_ROLE_KEY environment variable is required');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { email } = body;
  if (!email || typeof email !== 'string') {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing or invalid email' }) };
  }

  try {
    // Step 1: resolve the user ID from the profiles table (reliable, uses service role)
    const profileUrl = `${SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(email.trim().toLowerCase())}&select=id&limit=1`;
    const profileRes = await fetch(profileUrl, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
    });

    if (!profileRes.ok) {
      return { statusCode: 200, body: JSON.stringify({ isGoogleOnly: false }) };
    }

    const profiles = await profileRes.json();
    if (!Array.isArray(profiles) || !profiles.length) {
      return { statusCode: 200, body: JSON.stringify({ isGoogleOnly: false }) };
    }

    const userId = profiles[0].id;

    // Step 2: fetch the auth user record by ID to inspect their identities
    const userUrl = `${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`;
    const userRes = await fetch(userUrl, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
    });

    if (!userRes.ok) {
      return { statusCode: 200, body: JSON.stringify({ isGoogleOnly: false }) };
    }

    const user = await userRes.json();
    const identities = user.identities || [];
    const hasGoogle   = identities.some((id) => id.provider === 'google');
    const hasEmail    = identities.some((id) => id.provider === 'email');

    // isGoogleOnly: account has a Google identity but no email/password identity
    const isGoogleOnly = hasGoogle && !hasEmail;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isGoogleOnly }),
    };
  } catch (err) {
    console.error('auth-check-provider error:', err);
    // On unexpected errors, return isGoogleOnly=false to avoid blocking sign-in
    return {
      statusCode: 200,
      body: JSON.stringify({ isGoogleOnly: false }),
    };
  }
};
