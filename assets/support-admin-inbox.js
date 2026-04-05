import { getSupabase } from '/js/supabase-client.js';
import { requireAdmin, showToast, confirmModal, setBtnLoading } from '/js/auth.js';

const API = '/api';
const TYPING_DEBOUNCE_MS = 1200;
const TYPING_VISIBLE_MS = 8000;
const TYPING_PING_THROTTLE_MS = 3000;
const POLL_MS = 5000;
const PRESENCE_MS = 60000;

const state = {
  supabase: null,
  session: null,
  conversations: [],
  currentConversationId: null,
  currentThread: null,
  currentUserName: '',
  currentAdminName: 'Admin',
  replyDraftByConversation: {},
  typingTimer: null,
  typingActive: false,
  typingConversationId: null,
  lastTypingPingAt: 0,
  pollTimer: null,
  presenceTimer: null,
  supportSectionActive: false,
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

async function init() {
  const supportSection = document.getElementById('section-support');
  if (!supportSection) return;

  injectStyles();
  wireGlobals();

  state.supabase = await getSupabase();
  state.session = await requireAdmin();
  if (!state.session) return;

  const refreshBtn = document.getElementById('supportInboxRefreshBtn');
  refreshBtn?.addEventListener('click', () => loadConversations(true));

  if (document.getElementById('section-support')?.classList.contains('active')) {
    state.supportSectionActive = true;
    await loadConversations(false);
    startPolling();
    startPresencePing();
  }
}

function wireGlobals() {
  window.__adminSupportInboxOnSectionChange = async (section) => {
    state.supportSectionActive = section === 'support';
    if (section === 'support') {
      await loadConversations(false);
      startPolling();
      startPresencePing();
    } else {
      stopPolling();
      stopPresencePing();
      clearTimeout(state.typingTimer);
      if (state.typingActive && state.typingConversationId) {
        setTypingForConversation(state.typingConversationId, false);
      }
    }
  };
  window.__adminSupportInboxRefresh = async () => {
    await loadConversations(true);
  };
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(async () => {
    if (!state.supportSectionActive || document.hidden) return;
    try {
      await refreshRealtime();
    } catch {
      // best effort refresh
    }
  }, POLL_MS);
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function startPresencePing() {
  if (state.presenceTimer) return;
  const ping = () => apiFetch('ping-session').catch(() => {});
  ping();
  state.presenceTimer = setInterval(() => {
    if (!state.supportSectionActive || document.hidden) return;
    ping();
  }, PRESENCE_MS);
}

function stopPresencePing() {
  if (state.presenceTimer) {
    clearInterval(state.presenceTimer);
    state.presenceTimer = null;
  }
}

function injectStyles() {
  if (document.getElementById('support-inbox-styles')) return;
  const style = document.createElement('style');
  style.id = 'support-inbox-styles';
  style.textContent = `
    .support-layout {
      display: grid;
      grid-template-columns: minmax(300px, 380px) minmax(0, 1fr);
      gap: 1.9rem;
      align-items: start;
      margin-top: 1.2rem;
    }
    #section-support .card.support-pane > .card-body {
      padding: 1.25rem 1.35rem;
    }
    .support-pane {
      min-height: 640px;
    }
    .support-list {
      display: flex;
      flex-direction: column;
      gap: .7rem;
      max-height: 680px;
      overflow: auto;
      padding-right: .4rem;
    }
    .support-thread {
      display: flex;
      flex-direction: column;
      min-height: 620px;
      padding: .45rem .45rem .7rem;
    }
    .support-conv {
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: .85rem .95rem;
      background: var(--surface);
      cursor: pointer;
      transition: border-color .15s ease, background .15s ease, transform .15s ease;
    }
    .support-conv:hover {
      border-color: var(--primary-light);
      background: color-mix(in srgb, var(--primary-light) 18%, var(--surface));
      transform: translateY(-1px);
    }
    .support-conv.active {
      border-color: var(--primary);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--primary) 40%, transparent);
    }
    .support-conv-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: .75rem;
      margin-bottom: .4rem;
    }
    .support-conv-name {
      font-weight: 700;
      color: var(--text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .support-conv-meta, .support-thread-meta, .support-msg-meta {
      color: var(--text-muted);
      font-size: .8rem;
    }
    .support-conv-preview {
      color: var(--text-muted);
      font-size: .9rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .support-conv-badges {
      display: flex;
      gap: .35rem;
      flex-wrap: wrap;
      align-items: center;
    }
    .support-count {
      min-width: 1.5rem;
      height: 1.5rem;
      border-radius: 999px;
      background: var(--danger);
      color: #fff;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0 .4rem;
      font-size: .72rem;
      font-weight: 700;
    }
    .support-thread-head {
      border-bottom: 1px solid var(--border);
      padding-bottom: 1.15rem;
      margin-bottom: 1.15rem;
    }
    .support-thread-head-top {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      flex-wrap: wrap;
      align-items: start;
    }
    .support-thread-title {
      margin: 0;
      font-size: 1.1rem;
    }
    .support-thread-actions {
      display: flex;
      gap: .5rem;
      flex-wrap: wrap;
    }
    .support-thread-body {
      display: flex;
      flex-direction: column;
      gap: 1.15rem;
      flex: 1;
      min-height: 0;
    }
    .support-thread-messages {
      flex: 1;
      min-height: 280px;
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: .75rem;
      padding-right: .25rem;
    }
    .support-msg-row {
      display: flex;
      gap: .6rem;
      align-items: flex-end;
      max-width: 100%;
    }
    .support-msg-row.admin {
      justify-content: flex-end;
      flex-direction: row-reverse;
    }
    .support-msg-avatar {
      width: 2rem;
      height: 2rem;
      border-radius: 999px;
      background: var(--primary-light);
      color: var(--primary);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: .68rem;
      font-weight: 700;
      flex-shrink: 0;
      border: 1px solid color-mix(in srgb, var(--primary) 18%, var(--border));
    }
    .support-msg-content {
      max-width: min(720px, calc(100vw - 420px));
      min-width: 0;
      padding: .7rem .85rem;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      box-shadow: 0 1px 0 rgba(0,0,0,.03);
    }
    .support-msg-row.admin .support-msg-content {
      background: color-mix(in srgb, var(--primary) 13%, var(--surface));
      border-color: color-mix(in srgb, var(--primary) 18%, var(--border));
    }
    .support-msg-body {
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.45;
    }
    .support-msg-meta {
      margin-top: .35rem;
      display: flex;
      justify-content: space-between;
      gap: .75rem;
    }
    .support-thread-empty {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 320px;
      color: var(--text-muted);
      text-align: center;
      padding: 2rem;
    }
    .support-reply {
      border-top: 1px solid var(--border);
      padding-top: .85rem;
      display: flex;
      flex-direction: column;
      gap: .65rem;
    }
    .support-reply textarea {
      min-height: 110px;
      resize: vertical;
    }
    .support-typing {
      display: inline-flex;
      align-items: center;
      gap: .35rem;
      color: var(--text-muted);
      font-size: .84rem;
      min-height: 1.25rem;
    }
    .support-typing-dots {
      display: inline-flex;
      align-items: center;
      gap: .2rem;
      margin-left: .1rem;
    }
    .support-typing-dots span {
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: var(--primary);
      animation: supportTypingBounce 1.25s infinite ease-in-out;
    }
    .support-typing-dots span:nth-child(2) { animation-delay: .18s; }
    .support-typing-dots span:nth-child(3) { animation-delay: .36s; }
    @keyframes supportTypingBounce {
      0%, 80%, 100% { transform: translateY(0); opacity: .45; }
      40% { transform: translateY(-5px); opacity: 1; }
    }
    .support-pill {
      display: inline-flex;
      align-items: center;
      gap: .35rem;
      border-radius: 999px;
      border: 1px solid var(--border);
      padding: .2rem .55rem;
      font-size: .75rem;
      color: var(--text-muted);
      background: var(--bg);
    }
    @media (max-width: 980px) {
      .support-layout { grid-template-columns: 1fr; }
      .support-pane { min-height: auto; }
      .support-msg-content { max-width: 100%; }
    }
  `;
  document.head.appendChild(style);
}

async function apiFetch(endpoint, opts = {}) {
  const { data: { session } } = await state.supabase.auth.getSession();
  if (!session) throw new Error('No session');
  state.session = session;

  return fetch(`${API}/${endpoint}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return parts.slice(0, 2).map((part) => part[0].toUpperCase()).join('');
}

function formatDateTime(value) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function formatRelative(value) {
  if (!value) return '';
  try {
    const diff = Date.now() - new Date(value).getTime();
    if (Number.isNaN(diff)) return '';
    const minutes = Math.max(1, Math.round(diff / 60000));
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return `${days}d ago`;
  } catch {
    return '';
  }
}

function isTypingRecently(value) {
  if (!value) return false;
  return (Date.now() - new Date(value).getTime()) < TYPING_VISIBLE_MS;
}

async function loadConversations(keepSelection = false) {
  await loadConversationsInternal(keepSelection, true);
}

async function loadConversationsInternal(keepSelection = false, showLoading = true) {
  const listWrap = document.getElementById('supportConversationList');
  const threadWrap = document.getElementById('supportThreadWrap');
  if (listWrap && showLoading) {
    listWrap.innerHTML = '<div class="loading-state"><span class="spinner"></span> Loading…</div>';
  }
  if (threadWrap && !keepSelection && showLoading) {
    threadWrap.innerHTML = '<div class="support-thread-empty">Select a conversation to review the thread.</div>';
  }

  const res = await apiFetch('support-inbox');
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to load support conversations');

  state.conversations = json.conversations || [];
  renderConversationList();

  if (keepSelection && state.currentConversationId) {
    if (showLoading) {
      await loadConversationThread(state.currentConversationId, true, showLoading);
    }
  } else if (!state.currentConversationId && state.conversations.length) {
    await loadConversationThread(state.conversations[0].id, true, showLoading);
  }
}

async function refreshRealtime() {
  await loadConversationsInternal(true, false);

  if (!state.currentConversationId) return;

  const input = document.getElementById('supportReplyInput');
  const composing = !!(
    input && (
      document.activeElement === input ||
      state.typingActive ||
      input.value.trim().length > 0
    )
  );

  const threadRes = await apiFetch(`support-inbox?conversation_id=${encodeURIComponent(state.currentConversationId)}`);
  const threadJson = await threadRes.json();
  if (!threadRes.ok) return;

  const previous = state.currentThread;
  state.currentThread = threadJson;
  state.currentUserName = threadJson.user_name || state.currentUserName;
  state.currentAdminName = threadJson.admin_name || state.currentAdminName;

  const threadExists = !!document.getElementById('supportThreadMessages');
  const stateChanged = previous?.conversation?.resolved !== threadJson?.conversation?.resolved;
  if (!threadExists || stateChanged) {
    if (!composing) renderThread();
    return;
  }

  updateRealtimeThreadView(previous?.messages || [], threadJson.messages || [], threadJson.conversation);
}

function updateRealtimeThreadView(previousMessages, nextMessages, conversation) {
  const messageWrap = document.getElementById('supportThreadMessages');
  if (!messageWrap) return;

  const known = new Set(Array.from(messageWrap.querySelectorAll('[data-msg-id]')).map((node) => node.dataset.msgId));
  const atBottom = (messageWrap.scrollHeight - messageWrap.clientHeight - messageWrap.scrollTop) < 60;

  for (const message of nextMessages) {
    const id = String(message.id || '');
    if (!id || known.has(id)) continue;
    known.add(id);
    messageWrap.insertAdjacentHTML('beforeend', renderMessageRow(message));
  }

  if (atBottom) {
    messageWrap.scrollTop = messageWrap.scrollHeight;
  }

  const typingNode = document.getElementById('supportTypingLine');
  if (typingNode) {
    typingNode.innerHTML = conversation?.user_typing_at && isTypingRecently(conversation.user_typing_at)
      ? '<i class="fa-solid fa-pen-nib" aria-hidden="true"></i> Student is typing…'
      : '';
  }
}

function renderMessageRow(message) {
  const isAdmin = !!message.from_admin;
  const rowClass = isAdmin ? 'admin' : 'student';
  const avatar = initials(isAdmin ? state.currentAdminName : state.currentUserName);
  const senderName = isAdmin ? state.currentAdminName : state.currentUserName;
  return `
    <div class="support-msg-row ${rowClass}" data-msg-id="${escapeHtml(String(message.id || ''))}">
      <div class="support-msg-avatar">${escapeHtml(avatar)}</div>
      <div class="support-msg-content">
        <div class="support-msg-body">${escapeHtml(message.body)}</div>
        <div class="support-msg-meta">
          <span>${escapeHtml(senderName)}</span>
          <span>${escapeHtml(formatDateTime(message.created_at))}${message.read_at ? ' · read' : ''}</span>
        </div>
      </div>
    </div>`;
}

function renderConversationList() {
  const listWrap = document.getElementById('supportConversationList');
  if (!listWrap) return;

  if (!state.conversations.length) {
    listWrap.innerHTML = '<div class="empty-state"><div class="empty-icon"><i class="fa-solid fa-comments" aria-hidden="true"></i></div><p>No support conversations yet.</p></div>';
    return;
  }

  const items = state.conversations.map((conv) => {
    const active = conv.id === state.currentConversationId ? ' active' : '';
    const badge = conv.resolved ? '<span class="badge badge-success">Resolved</span>' : '<span class="badge badge-primary">Open</span>';
    const count = conv.unread_count > 0 ? `<span class="support-count" title="Unread student messages">${conv.unread_count > 99 ? '99+' : conv.unread_count}</span>` : '';
    const preview = conv.last_message || 'No messages yet';
    return `
      <button type="button" class="support-conv${active}" data-id="${escapeHtml(conv.id)}">
        <div class="support-conv-top">
          <div class="support-conv-name">${escapeHtml(conv.user_name || conv.user_email)}</div>
          <div class="support-conv-badges">${badge}${count}</div>
        </div>
        <div class="support-conv-meta">${escapeHtml(conv.user_email)}</div>
        <div class="support-conv-preview">${escapeHtml(preview)}</div>
        <div class="support-conv-meta" style="margin-top:.35rem;display:flex;justify-content:space-between;gap:.5rem;flex-wrap:wrap;">
          <span>${escapeHtml(formatRelative(conv.last_at) || formatDateTime(conv.last_at))}</span>
          ${conv.user_typing_at && isTypingRecently(conv.user_typing_at) ? '<span class="support-pill"><i class="fa-solid fa-pen-nib" aria-hidden="true"></i> Student typing <span class="support-typing-dots" aria-hidden="true"><span></span><span></span><span></span></span></span>' : ''}
        </div>
      </button>`;
  }).join('');

  listWrap.innerHTML = `<div class="support-list">${items}</div>`;
  listWrap.querySelectorAll('.support-conv').forEach((button) => {
    button.addEventListener('click', () => loadConversationThread(button.dataset.id, false));
  });
}

async function loadConversationThread(conversationId, forceRefresh = false, showLoading = true) {
  if (!conversationId) return;
  const previousConversationId = state.currentConversationId;
  if (state.typingActive && previousConversationId && previousConversationId !== conversationId) {
    clearTimeout(state.typingTimer);
    await setTypingForConversation(previousConversationId, false);
  }
  state.currentConversationId = conversationId;

  const threadWrap = document.getElementById('supportThreadWrap');
  if (threadWrap && showLoading) {
    threadWrap.innerHTML = '<div class="loading-state"><span class="spinner"></span> Loading conversation…</div>';
  }

  const res = await apiFetch(`support-inbox?conversation_id=${encodeURIComponent(conversationId)}`);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to load conversation');

  state.currentThread = json;
  state.currentUserName = json.user_name || 'Student';
  state.currentAdminName = json.admin_name || 'Admin';
  renderConversationList();
  renderThread();
  restoreReplyDraft(conversationId);
  if (forceRefresh) {
    renderConversationList();
  }
}

function renderThread() {
  const threadWrap = document.getElementById('supportThreadWrap');
  if (!threadWrap) return;

  const thread = state.currentThread;
  if (!thread || !thread.conversation) {
    threadWrap.innerHTML = '<div class="support-thread-empty">Select a conversation to review the thread.</div>';
    return;
  }

  const conversation = thread.conversation;
  const messages = thread.messages || [];
  const resolved = conversation.resolved;
  const statusPill = resolved
    ? '<span class="support-pill"><i class="fa-solid fa-circle-check" aria-hidden="true"></i> Resolved</span>'
    : '<span class="support-pill"><i class="fa-solid fa-comment-dots" aria-hidden="true"></i> Open</span>';
  const typingLine = conversation.user_typing_at && isTypingRecently(conversation.user_typing_at)
    ? '<i class="fa-solid fa-pen-nib" aria-hidden="true"></i> Student is typing <span class="support-typing-dots" aria-hidden="true"><span></span><span></span><span></span></span>'
    : '';

  const headerButtons = resolved
    ? `
      <button type="button" class="btn btn-outline btn-sm" id="supportUnresolveBtn">Reopen</button>
      <button type="button" class="btn btn-danger btn-sm" id="supportDeleteBtn">Delete</button>`
    : `
      <button type="button" class="btn btn-outline btn-sm" id="supportResolveBtn">Resolve</button>
      <button type="button" class="btn btn-danger btn-sm" id="supportDeleteBtn">Delete</button>`;

  const messageHtml = messages.length
    ? messages.map((message) => renderMessageRow(message)).join('')
    : '<div class="support-thread-empty" style="min-height:220px;">No messages in this conversation yet.</div>';

  threadWrap.innerHTML = `
    <div class="support-thread support-pane">
      <div class="support-thread-head">
        <div class="support-thread-head-top">
          <div>
            <h2 class="support-thread-title">${escapeHtml(state.currentUserName || conversation.user_email)}</h2>
            <div class="support-thread-meta">${escapeHtml(conversation.user_email)} · ${escapeHtml(formatDateTime(conversation.created_at))}</div>
          </div>
          <div class="support-thread-actions">
            ${statusPill}
            ${headerButtons}
          </div>
        </div>
      </div>
      <div class="support-thread-body">
        <div class="support-typing" id="supportTypingLine">${typingLine}</div>
        <div class="support-thread-messages" id="supportThreadMessages">${messageHtml}</div>
        <form class="support-reply" id="supportReplyForm">
          <label for="supportReplyInput" class="bold">Reply to student</label>
          <textarea id="supportReplyInput" class="form-input" placeholder="Write your reply…"></textarea>
          <div class="flex items-center justify-between gap-2" style="flex-wrap:wrap;">
            <span class="support-thread-meta" id="supportReplyMeta">${messages.length} message${messages.length === 1 ? '' : 's'}</span>
            <div class="flex gap-2" style="flex-wrap:wrap;">
              <button type="button" class="btn btn-ghost btn-sm" id="supportClearReplyBtn">Clear</button>
              <button type="submit" class="btn btn-primary btn-sm" id="supportSendReplyBtn"><i class="fa-solid fa-paper-plane" aria-hidden="true"></i> Send</button>
            </div>
          </div>
        </form>
      </div>
    </div>`;

  document.getElementById('supportResolveBtn')?.addEventListener('click', () => updateConversation('resolve'));
  document.getElementById('supportUnresolveBtn')?.addEventListener('click', () => updateConversation('unresolve'));
  document.getElementById('supportDeleteBtn')?.addEventListener('click', () => deleteConversation());
  const replyForm = document.getElementById('supportReplyForm');
  const replyInput = document.getElementById('supportReplyInput');

  replyForm?.addEventListener('submit', handleReplySubmit);
  replyInput?.addEventListener('input', handleTypingInput);
  replyInput?.addEventListener('blur', () => setTyping(false));
  replyInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      replyInput.value = '';
      setTyping(false);
      renderReplyCount();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      replyForm?.requestSubmit();
    }
  });

  document.getElementById('supportClearReplyBtn')?.addEventListener('click', () => {
    if (replyInput) {
      replyInput.value = '';
      saveReplyDraft('');
      renderReplyCount();
      setTyping(false);
      replyInput.focus();
    }
  });

  renderReplyCount();
  const msgWrap = document.getElementById('supportThreadMessages');
  if (msgWrap) msgWrap.scrollTop = msgWrap.scrollHeight;
}

function renderReplyCount() {
  const input = document.getElementById('supportReplyInput');
  const meta = document.getElementById('supportReplyMeta');
  if (!input || !meta) return;
  const count = input.value.trim().length;
  meta.textContent = `${count} character${count === 1 ? '' : 's'}`;
}

function saveReplyDraft(value) {
  if (!state.currentConversationId) return;
  state.replyDraftByConversation[state.currentConversationId] = value;
}

function restoreReplyDraft(conversationId = state.currentConversationId) {
  const input = document.getElementById('supportReplyInput');
  if (!input || !conversationId) return;
  input.value = state.replyDraftByConversation[conversationId] || '';
  renderReplyCount();
}

async function handleReplySubmit(event) {
  event.preventDefault();
  if (!state.currentConversationId) return;
  const input = document.getElementById('supportReplyInput');
  const button = document.getElementById('supportSendReplyBtn');
  const message = input?.value.trim() || '';
  if (!message) return;

  setBtnLoading(button, true, 'Sending…');
  try {
    const res = await apiFetch('support-inbox', {
      method: 'POST',
      body: JSON.stringify({
        action: 'reply',
        conversation_id: state.currentConversationId,
        message,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Failed to send reply');
    input.value = '';
    saveReplyDraft('');
    renderReplyCount();
    setTyping(false);
    showToast('Reply sent.', 'success');
    await refreshRealtime();
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setBtnLoading(button, false);
  }
}

async function updateConversation(action) {
  if (!state.currentConversationId) return;
  try {
    const res = await apiFetch('support-inbox', {
      method: 'POST',
      body: JSON.stringify({
        action,
        conversation_id: state.currentConversationId,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Action failed');
    showToast(action === 'resolve' ? 'Conversation resolved.' : 'Conversation reopened.', 'success');
    await refreshRealtime();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function deleteConversation() {
  if (!state.currentConversationId) return;
  const confirmed = await confirmModal(
    'Delete this conversation and all of its messages? This cannot be undone.',
    'Delete Conversation',
    true,
  );
  if (!confirmed) return;

  try {
    const res = await apiFetch('support-inbox', {
      method: 'POST',
      body: JSON.stringify({
        action: 'delete',
        conversation_id: state.currentConversationId,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Delete failed');
    showToast('Conversation deleted.', 'success');
    if (state.currentConversationId) {
      delete state.replyDraftByConversation[state.currentConversationId];
    }
    state.currentConversationId = null;
    state.currentThread = null;
    await loadConversations(false);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function handleTypingInput() {
  const input = document.getElementById('supportReplyInput');
  if (input) saveReplyDraft(input.value);
  renderReplyCount();
  pingTypingTrue();
  clearTimeout(state.typingTimer);
  state.typingTimer = setTimeout(() => setTyping(false), TYPING_DEBOUNCE_MS);
}

function pingTypingTrue() {
  const conversationId = state.currentConversationId;
  if (!conversationId) return;
  const now = Date.now();
  if (state.typingActive && state.typingConversationId === conversationId && (now - state.lastTypingPingAt) < TYPING_PING_THROTTLE_MS) {
    return;
  }
  state.lastTypingPingAt = now;
  state.typingActive = true;
  state.typingConversationId = conversationId;
  apiFetch('support-typing', {
    method: 'POST',
    body: JSON.stringify({
      conversation_id: conversationId,
      typing: true,
    }),
  }).catch(() => {
    // typing indicators are best-effort
  });
}

async function setTyping(typing) {
  return setTypingForConversation(state.currentConversationId, typing);
}

async function setTypingForConversation(conversationId, typing) {
  if (!conversationId) return;
  if (typing) {
    if (state.typingActive && state.typingConversationId === conversationId) return;
    state.typingActive = true;
    state.typingConversationId = conversationId;
  } else {
    if (!state.typingActive || state.typingConversationId !== conversationId) return;
    state.typingActive = false;
    state.typingConversationId = null;
    state.lastTypingPingAt = 0;
  }

  try {
    await apiFetch('support-typing', {
      method: 'POST',
      body: JSON.stringify({
        conversation_id: conversationId,
        typing,
      }),
    });
  } catch {
    // typing indicators are best-effort
  }
}
