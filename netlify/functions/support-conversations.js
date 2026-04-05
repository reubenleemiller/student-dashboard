// netlify/functions/support-conversations.js
// Handles conversation-level actions for the authenticated user.
//
// POST body: { action: "resolve_own"|"reopen_own"|"delete_own", conversation_id: "<uuid>" }
//
// Environment variables required:
//   SUPABASE_URL              – Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY – service-role key

'use strict';

const SUPABASE_URL          = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

const { authenticate } = require('./_auth.js');

async function sbFetch(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      apikey:         SUPABASE_SERVICE_ROLE,
      Authorization:  `Bearer ${SUPABASE_SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      Prefer:         'return=representation',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`DB ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  }

  const auth = await authenticate(event);
  if (auth.error) {
    return {
      statusCode: auth.error.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: auth.error.message }),
    };
  }

  const { user } = auth;

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  const { action, conversation_id } = body;
  if (!action || !conversation_id) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: '"action" and "conversation_id" are required' }),
    };
  }

  // Verify the conversation belongs to this user
  let conv;
  try {
    const rows = await sbFetch(
      `/support_conversations?id=eq.${encodeURIComponent(conversation_id)}&user_id=eq.${user.id}&limit=1`
    );
    conv = Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }

  if (!conv) {
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Conversation not found' }),
    };
  }

  try {
    switch (action) {
      case 'resolve_own':
        await sbFetch(
          `/support_conversations?id=eq.${encodeURIComponent(conversation_id)}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ resolved: true, resolved_at: new Date().toISOString() }),
          }
        );
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ok: true }),
        };

      case 'reopen_own':
        await sbFetch(
          `/support_conversations?id=eq.${encodeURIComponent(conversation_id)}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ resolved: false, resolved_at: null }),
          }
        );
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ok: true }),
        };

      case 'delete_own':
        // Delete messages first (FK constraint), then the conversation
        await sbFetch(
          `/support_messages?conversation_id=eq.${encodeURIComponent(conversation_id)}`,
          { method: 'DELETE', headers: { Prefer: 'return=minimal' } }
        );
        await sbFetch(
          `/support_conversations?id=eq.${encodeURIComponent(conversation_id)}`,
          { method: 'DELETE', headers: { Prefer: 'return=minimal' } }
        );
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ok: true }),
        };

      default:
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: `Unknown action: ${action}` }),
        };
    }
  } catch (err) {
    console.error('support-conversations error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
