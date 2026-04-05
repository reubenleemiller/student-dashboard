// netlify/functions/support-messages.js
// GET  – Returns the active conversation, its messages, unread count,
//        previous resolved conversations, and admin info for the current user.
//        Query params:
//          ?mark_read=1           – marks unread admin messages as read
//          ?conversation_id=<id>  – load messages for a specific (past) conversation
//                                   that belongs to this user (read-only)
// POST – Sends a new message (creates a conversation if none is active).
//
// Environment variables required:
//   SUPABASE_URL              – Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY – service-role key

'use strict';

const SUPABASE_URL          = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

const { authenticate } = require('./_auth.js');

/** Call the Supabase REST API with service-role auth. */
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
  const auth = await authenticate(event);
  if (auth.error) {
    return {
      statusCode: auth.error.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: auth.error.message }),
    };
  }

  const { user, profile } = auth;
  const qs = event.queryStringParameters || {};

  // ── GET ─────────────────────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    // Load messages for a specific past conversation (read-only view)
    if (qs.conversation_id) {
      const convId = qs.conversation_id;
      // Verify conversation belongs to this user
      const convRows = await sbFetch(
        `/support_conversations?id=eq.${encodeURIComponent(convId)}&user_id=eq.${user.id}&limit=1`
      ).catch(() => []);
      const conv = Array.isArray(convRows) && convRows.length ? convRows[0] : null;
      if (!conv) {
        return {
          statusCode: 404,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Conversation not found' }),
        };
      }
      const messages = await sbFetch(
        `/support_messages?conversation_id=eq.${encodeURIComponent(convId)}&order=created_at.asc`
      ).catch(() => []);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({ conversation: conv, messages: messages || [] }),
      };
    }

    const markRead = qs.mark_read === '1';

    // Active (unresolved) conversation for this user
    const activeConvs = await sbFetch(
      `/support_conversations?user_id=eq.${user.id}&resolved=eq.false&order=created_at.desc&limit=1`
    ).catch(() => []);
    const conversation =
      Array.isArray(activeConvs) && activeConvs.length ? activeConvs[0] : null;

    let messages = [];
    if (conversation) {
      messages = await sbFetch(
        `/support_messages?conversation_id=eq.${conversation.id}&order=created_at.asc`
      ).catch(() => []) || [];

      if (markRead) {
        const unread = messages.filter(m => m.from_admin && !m.read_at);
        if (unread.length) {
          const now = new Date().toISOString();
          await sbFetch(
            `/support_messages?conversation_id=eq.${conversation.id}&from_admin=eq.true&read_at=is.null`,
            { method: 'PATCH', body: JSON.stringify({ read_at: now }) }
          ).catch(() => {});
          messages = messages.map(m =>
            (m.from_admin && !m.read_at) ? { ...m, read_at: now } : m
          );
        }
      }
    }

    // Previous (resolved) conversations
    const prevConvs = await sbFetch(
      `/support_conversations?user_id=eq.${user.id}&resolved=eq.true&order=resolved_at.desc&limit=10`
    ).catch(() => []) || [];

    const prevWithMeta = await Promise.all(
      prevConvs.map(async (conv) => {
        const msgs = await sbFetch(
          `/support_messages?conversation_id=eq.${conv.id}&order=created_at.desc&limit=1`
        ).catch(() => []);
        return {
          ...conv,
          last_message: Array.isArray(msgs) && msgs.length ? msgs[0] : null,
        };
      })
    );

    const unreadCount = messages.filter(m => m.from_admin && !m.read_at).length;

    const adminRows = await sbFetch(
      '/profiles?role=eq.admin&select=full_name,photo_url&limit=1'
    ).catch(() => []);
    const admin = Array.isArray(adminRows) && adminRows.length ? adminRows[0] : {};

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        conversation,
        messages,
        unread_count:           unreadCount,
        previous_conversations: prevWithMeta,
        admin_name:             admin.full_name  || 'Support',
        admin_photo:            admin.photo_url  || null,
        user_name:              profile?.full_name || user.email,
        user_photo:             profile?.photo_url || null,
        admin_typing_at:        conversation?.admin_typing_at || null,
      }),
    };
  }

  // ── POST ────────────────────────────────────────────────────────────
  if (event.httpMethod === 'POST') {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid JSON body' }),
      };
    }

    const { message } = body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: '"message" field is required and must be non-empty' }),
      };
    }

    // Get or create an active conversation
    const activeConvs = await sbFetch(
      `/support_conversations?user_id=eq.${user.id}&resolved=eq.false&order=created_at.desc&limit=1`
    ).catch(() => []);

    let conversation;
    if (Array.isArray(activeConvs) && activeConvs.length) {
      conversation = activeConvs[0];
    } else {
      const created = await sbFetch('/support_conversations', {
        method: 'POST',
        body: JSON.stringify({
          user_id:    user.id,
          user_email: user.email,
          resolved:   false,
        }),
      });
      conversation = Array.isArray(created) ? created[0] : created;
    }

    if (!conversation?.id) {
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Failed to get or create conversation' }),
      };
    }

    const newMsgResult = await sbFetch('/support_messages', {
      method: 'POST',
      body: JSON.stringify({
        conversation_id: conversation.id,
        user_id:         user.id,
        user_email:      user.email,
        body:            message.trim(),
        from_admin:      false,
      }),
    });
    const savedMsg = Array.isArray(newMsgResult) ? newMsgResult[0] : newMsgResult;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, message: savedMsg, conversation_id: conversation.id }),
    };
  }

  return {
    statusCode: 405,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: 'Method Not Allowed' }),
  };
};
