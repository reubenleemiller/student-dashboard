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
const SITE_URL              = (process.env.SITE_URL || '').replace(/\/$/, '');

const { authenticate } = require('./_auth.js');
const { sendEmail, escHtml, getSiteTitle } = require('./_email.js');

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

async function buildTranscriptRows(conversationId, userLabel) {
  const messages = await sbFetch(
    `/support_messages?conversation_id=eq.${encodeURIComponent(conversationId)}&select=body,from_admin,created_at&order=created_at.asc`
  ).catch(() => []);

  return (messages || []).map((message) => {
    const sender = message.from_admin ? 'Support Team' : escHtml(userLabel);
    const time = new Date(message.created_at).toLocaleString();
    return '<tr>' +
      `<td style="padding:6px 12px;white-space:nowrap;color:#555;font-size:0.88em;">${sender}</td>` +
      `<td style="padding:6px 12px;white-space:nowrap;color:#999;font-size:0.82em;">${escHtml(time)}</td>` +
      `<td style="padding:6px 12px;word-break:break-word;">${escHtml(message.body)}</td>` +
      '</tr>';
  }).join('');
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

        try {
          const siteTitle = getSiteTitle();
          const userLabel = auth.profile?.full_name || user.email;
          const rows = await buildTranscriptRows(conversation_id, userLabel);
          await sendEmail({
            to: user.email,
            subject: `Your support conversation has been resolved - ${siteTitle}`,
            html: `
              <p>Hello ${escHtml(userLabel)},</p>
              <p>Your support conversation on <em>${escHtml(siteTitle)}</em> has been marked as resolved. Here is a transcript:</p>
              <table style="border-collapse:collapse;width:100%;margin:16px 0;font-size:0.95em;">
                <thead><tr style="background:#f5f5f5;">
                  <th style="padding:6px 12px;text-align:left;border-bottom:2px solid #7FC571;">From</th>
                  <th style="padding:6px 12px;text-align:left;border-bottom:2px solid #7FC571;">Time</th>
                  <th style="padding:6px 12px;text-align:left;border-bottom:2px solid #7FC571;">Message</th>
                </tr></thead>
                <tbody>${rows}</tbody>
              </table>
              ${SITE_URL ? `<p style="margin:24px 0;"><a href="${SITE_URL}/dashboard.html" style="background:#7FC571;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold;">Open Dashboard</a></p>` : ''}
            `,
          });
        } catch (emailErr) {
          console.error('support-conversations resolve_own transcript email failed', emailErr);
        }

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
