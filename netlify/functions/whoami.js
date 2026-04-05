// netlify/functions/whoami.js
// Returns the authenticated user's basic info.
//
// Environment variables required:
//   SUPABASE_URL              – Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY – service-role key

'use strict';

const { authenticate } = require('./_auth.js');

exports.handler = async (event) => {
  const auth = await authenticate(event);
  if (auth.error) {
    return {
      statusCode: auth.error.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: auth.error.message }),
    };
  }

  const { user, profile } = auth;
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({
      id:        user.id,
      email:     user.email,
      full_name: profile?.full_name || null,
      photo_url: profile?.photo_url || null,
      role:      profile?.role      || 'student',
    }),
  };
};
