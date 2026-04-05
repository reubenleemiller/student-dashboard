'use strict';

const SUPABASE_URL          = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_EMAIL           = process.env.ADMIN_EMAIL || 'reuben.miller@rmtutoringservices.com';
const SITE_URL              = (process.env.SITE_URL || '').replace(/\/$/, '');
const INACTIVE_MS           = 5 * 60 * 1000;

const { authenticate } = require('./_auth.js');
const { sendEmail, escHtml, getSiteTitle } = require('./_email.js');

async function sbFetch(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      apikey:        SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      Prefer:        'return=representation',
      ...(opts.headers || {}),
    },
  });

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`DB ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

async function getProfileName(userId, fallbackEmail) {
  const rows = await sbFetch(
    `/profiles?id=eq.${encodeURIComponent(userId)}&select=full_name&limit=1`
  ).catch(() => []);
  const profile = Array.isArray(rows) && rows.length ? rows[0] : null;
  return profile?.full_name || fallbackEmail || 'User';
}

async function getAdminName(userId) {
  const rows = await sbFetch(
    `/profiles?id=eq.${encodeURIComponent(userId)}&select=full_name,role&limit=1`
  ).catch(() => []);
  const profile = Array.isArray(rows) && rows.length ? rows[0] : null;
  return profile?.full_name || 'Admin';
}

async function getMessagesForTranscript(conversationId) {
  return sbFetch(
    `/support_messages?conversation_id=eq.${encodeURIComponent(conversationId)}&select=body,from_admin,created_at&order=created_at.asc`
  ).catch(() => []);
}

async function getConversationById(conversationId) {
  const rows = await sbFetch(
    `/support_conversations?id=eq.${encodeURIComponent(conversationId)}&limit=1`
  ).catch(() => []);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function listConversations() {
  const convs = await sbFetch(
    '/support_conversations?order=created_at.desc'
  ).catch(() => []);

  const conversations = await Promise.all((convs || []).map(async (conv) => {
    const [lastRows, unreadRows, userName] = await Promise.all([
      sbFetch(
        `/support_messages?conversation_id=eq.${encodeURIComponent(conv.id)}&order=created_at.desc&limit=1`
      ).catch(() => []),
      sbFetch(
        `/support_messages?conversation_id=eq.${encodeURIComponent(conv.id)}&from_admin=eq.false&read_at=is.null&select=id`
      ).catch(() => []),
      getProfileName(conv.user_id, conv.user_email),
    ]);

    const lastMessage = Array.isArray(lastRows) && lastRows.length ? lastRows[0] : null;
    const unreadCount = Array.isArray(unreadRows) ? unreadRows.length : 0;

    return {
      id:            conv.id,
      user_id:       conv.user_id,
      user_email:    conv.user_email,
      user_name:     userName,
      resolved:      conv.resolved,
      resolved_at:   conv.resolved_at,
      created_at:    conv.created_at,
      last_message:  lastMessage?.body || '',
      last_at:       lastMessage?.created_at || conv.created_at,
      from_admin:    !!lastMessage?.from_admin,
      unread_count:  unreadCount,
      admin_typing_at: conv.admin_typing_at || null,
      user_typing_at:  conv.user_typing_at || null,
    };
  }));

  conversations.sort((a, b) => new Date(b.last_at) - new Date(a.last_at));
  return conversations;
}

async function loadThread(conversationId, adminUserId, markRead = true) {
  const conversation = await getConversationById(conversationId);
  if (!conversation) return null;

  const userName = await getProfileName(conversation.user_id, conversation.user_email);
  const adminName = await getAdminName(adminUserId);
  const messages = await sbFetch(
    `/support_messages?conversation_id=eq.${encodeURIComponent(conversationId)}&order=created_at.asc`
  ).catch(() => []);

  let normalizedMessages = Array.isArray(messages) ? messages : [];

  if (markRead) {
    const unread = normalizedMessages.filter((message) => !message.from_admin && !message.read_at);
    if (unread.length) {
      const now = new Date().toISOString();
      await sbFetch(
        `/support_messages?conversation_id=eq.${encodeURIComponent(conversationId)}&from_admin=eq.false&read_at=is.null`,
        {
          method: 'PATCH',
          body: JSON.stringify({ read_at: now }),
        }
      ).catch(() => {});
      normalizedMessages = normalizedMessages.map((message) => (
        !message.from_admin && !message.read_at ? { ...message, read_at: now } : message
      ));
    }
  }

  return {
    conversation,
    messages: normalizedMessages,
    user_name: userName,
    admin_name: adminName,
  };
}

exports.handler = async (event) => {
  const auth = await authenticate(event);
  if (auth.error) {
    return json(auth.error.status, { error: auth.error.message });
  }

  const { user, profile } = auth;
  const isAdmin = profile?.role === 'admin' || user.email === ADMIN_EMAIL;
  if (!isAdmin) {
    return json(403, { error: 'Forbidden' });
  }

  if (event.httpMethod === 'GET') {
    const qs = event.queryStringParameters || {};
    if (qs.conversation_id) {
      const thread = await loadThread(qs.conversation_id, user.id, true);
      if (!thread) {
        return json(404, { error: 'Conversation not found' });
      }
      return json(200, thread);
    }

    const conversations = await listConversations();
    return json(200, { conversations });
  }

  if (event.httpMethod === 'POST') {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch {
      return json(400, { error: 'Invalid JSON body' });
    }

    const { action, conversation_id, message } = body;
    if (!action || !conversation_id) {
      return json(400, { error: '"action" and "conversation_id" are required' });
    }

    const conversation = await getConversationById(conversation_id);
    if (!conversation) {
      return json(404, { error: 'Conversation not found' });
    }

    try {
      if (action === 'reply') {
        if (!message || typeof message !== 'string' || !message.trim()) {
          return json(400, { error: '"message" must be a non-empty string' });
        }

        const rows = await sbFetch('/support_messages', {
          method: 'POST',
          body: JSON.stringify({
            conversation_id,
            user_id: conversation.user_id,
            user_email: conversation.user_email,
            body: message.trim(),
            from_admin: true,
            read_at: null,
          }),
        });

        const saved = Array.isArray(rows) && rows.length ? rows[0] : rows;

        await sbFetch(
          `/support_conversations?id=eq.${encodeURIComponent(conversation_id)}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              resolved: false,
              resolved_at: null,
              admin_typing_at: null,
            }),
          }
        ).catch(() => {});

        try {
          const userRows = await sbFetch(
            `/profiles?id=eq.${encodeURIComponent(conversation.user_id)}&select=full_name,last_seen_at&limit=1`
          ).catch(() => []);
          const userProfile = Array.isArray(userRows) && userRows.length ? userRows[0] : null;
          const userName = userProfile?.full_name || conversation.user_email;
          const lastSeenStr = userProfile?.last_seen_at || null;
          const lastSeenMs = lastSeenStr ? new Date(lastSeenStr).getTime() : null;
          const inactive = lastSeenMs === null || (Date.now() - lastSeenMs) > INACTIVE_MS;

          if (inactive) {
            const siteTitle = getSiteTitle();
            await sendEmail({
              to: conversation.user_email,
              subject: `You have a new reply on ${siteTitle}`,
              html: `
                <p>Hello ${escHtml(userName)},</p>
                <p>The tutor replied to your support message on <em>${escHtml(siteTitle)}</em>:</p>
                <blockquote style="border-left:3px solid #7FC571;padding:8px 16px;margin:16px 0;color:#333;">
                  ${escHtml(message.trim())}
                </blockquote>
                ${SITE_URL ? `<p style="margin:24px 0;"><a href="${SITE_URL}/dashboard.html" style="background:#7FC571;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold;">View Your Messages</a></p>` : ''}
              `,
            });
            if (saved?.id) {
              await sbFetch(`/support_messages?id=eq.${saved.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ notified_at: new Date().toISOString() }),
              }).catch(() => {});
            }
          }
        } catch (emailErr) {
          console.error('support-inbox reply email failed', emailErr);
        }

        return json(200, {
          ok: true,
          message: saved,
        });
      }

      if (action === 'resolve') {
        const nowIso = new Date().toISOString();
        await sbFetch(
          `/support_conversations?id=eq.${encodeURIComponent(conversation_id)}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ resolved: true, resolved_at: nowIso, admin_typing_at: null }),
          }
        );

        try {
          const userRows = await sbFetch(
            `/profiles?id=eq.${encodeURIComponent(conversation.user_id)}&select=full_name&limit=1`
          ).catch(() => []);
          const userProfile = Array.isArray(userRows) && userRows.length ? userRows[0] : null;
          const userName = userProfile?.full_name || conversation.user_email;
          const siteTitle = getSiteTitle();
          const messages = await getMessagesForTranscript(conversation_id);
          const rows = (messages || []).map((msg) => {
            const sender = msg.from_admin ? 'Support Team' : escHtml(userName);
            const time = new Date(msg.created_at).toLocaleString();
            return '<tr>' +
              `<td style="padding:6px 12px;white-space:nowrap;color:#555;font-size:0.88em;">${sender}</td>` +
              `<td style="padding:6px 12px;white-space:nowrap;color:#999;font-size:0.82em;">${escHtml(time)}</td>` +
              `<td style="padding:6px 12px;word-break:break-word;">${escHtml(msg.body)}</td>` +
              '</tr>';
          }).join('');

          await sendEmail({
            to: conversation.user_email,
            subject: `Your support conversation has been resolved - ${siteTitle}`,
            html: `
              <p>Hello ${escHtml(userName)},</p>
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
          console.error('support-inbox resolve transcript email failed', emailErr);
        }

        return json(200, { ok: true });
      }

      if (action === 'unresolve') {
        await sbFetch(
          `/support_conversations?id=eq.${encodeURIComponent(conversation_id)}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ resolved: false, resolved_at: null, admin_typing_at: null }),
          }
        );
        return json(200, { ok: true });
      }

      if (action === 'delete') {
        await sbFetch(
          `/support_messages?conversation_id=eq.${encodeURIComponent(conversation_id)}`,
          { method: 'DELETE', headers: { Prefer: 'return=minimal' } }
        );
        await sbFetch(
          `/support_conversations?id=eq.${encodeURIComponent(conversation_id)}`,
          { method: 'DELETE', headers: { Prefer: 'return=minimal' } }
        );
        return json(200, { ok: true });
      }

      return json(400, { error: `Unknown action: ${action}` });
    } catch (err) {
      console.error('support-inbox error:', err);
      return json(500, { error: err.message });
    }
  }

  return json(405, { error: 'Method Not Allowed' });
};
