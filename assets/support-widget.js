// assets/support-widget.js
// Self-contained support chat widget for RM Tutoring Student Dashboard.
// Injects its own styles (using the page's CSS custom properties) and UI.
// Communicates with backend via Netlify Functions.
//
// Usage: <script src="/assets/support-widget.js"></script>
// Requires: Font Awesome (already loaded on dashboard.html), css/styles.css (CSS variables).

(function () {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────────
  const API      = '/.netlify/functions';
  const POLL_MS  = 5000;   // Message polling interval (ms)
  const TYPING_S = 3000;   // Typing-stop debounce (ms)
  const TOAST_MS = 6000;   // Toast auto-hide duration (ms)
  const ADMIN_TYPING_TTL = 8000; // How long to show "admin typing" (ms)
  const PRESENCE_MS = 60000;

  // ── Mutable state ────────────────────────────────────────────────────
  let _sb           = null;   // Supabase client
  let _token        = null;   // Current access token
  let _state = {
    open:           false,
    conversation:   null,     // Active conversation object
    messages:       [],       // Messages in active conversation
    prevConvs:      [],       // Previous (resolved) conversations
    showPrev:       false,    // Whether prev-convs section is expanded
    selectedPrevId: null,     // Viewing a specific past conversation
    prevMsgCache:   {},       // Cache of messages keyed by conversation_id
    adminName:      'Support',
    userName:       null,
    adminTypingAt:  null,
    unread:         0,
    loading:        false,
    isTyping:       false,
    typingTimer:    null,
    pollTimer:      null,
    presenceTimer:  null,
    toastTimer:     null,
  };

  // ── Initialisation ───────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  async function init() {
    try {
      // Load Supabase URL / anon key from the runtime config endpoint
      const cfgRes = await fetch('/api/public-config');
      if (!cfgRes.ok) return;
      const { supabaseUrl, supabaseAnonKey } = await cfgRes.json();

      // Dynamically import the Supabase ESM bundle (CSP allows cdn.jsdelivr.net)
      const { createClient } = await import(
        'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'
      );
      _sb = createClient(supabaseUrl, supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true },
      });

      // Get the user's current session
      const { data: { session } } = await _sb.auth.getSession();
      if (!session) return; // Not logged in – widget stays hidden
      _token = session.access_token;

      // Build the widget
      injectStyles();
      buildDOM();
      attachEvents();
      await loadMessages(false);
      startPolling();
      startPresencePing();
    } catch (err) {
      console.warn('[support-widget] init error:', err);
    }
  }

  // ── API helpers ───────────────────────────────────────────────────────
  async function refreshToken() {
    try {
      const { data: { session } } = await _sb.auth.getSession();
      if (session) _token = session.access_token;
    } catch { /* ignore */ }
  }

  async function apiFetch(endpoint, opts = {}) {
    await refreshToken();
    return fetch(`${API}/${endpoint}`, {
      ...opts,
      headers: {
        Authorization:  `Bearer ${_token}`,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
  }

  // ── Styles ────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('sw-styles')) return;
    const s = document.createElement('style');
    s.id = 'sw-styles';
    s.textContent = `
      /* ── Support Widget ────────────────────────────────────────── */
      .sw-gone { display: none !important; }

      #sw-fab {
        position: fixed; bottom: 24px; right: 24px;
        width: 52px; height: 52px; border-radius: 50%;
        background: var(--primary, #7FC571); color: #fff;
        border: none; cursor: pointer; font-size: 1.25rem;
        display: flex; align-items: center; justify-content: center;
        box-shadow: 0 4px 14px rgba(127,197,113,.45);
        z-index: 9000; transition: background .2s, transform .15s;
        outline-offset: 3px;
      }
      #sw-fab:hover  { background: var(--primary-hover, #6aaa5e); transform: scale(1.06); }
      #sw-fab:active { transform: scale(.96); }
      #sw-fab:focus-visible { outline: 2px solid var(--primary, #7FC571); }

      #sw-badge {
        position: absolute; top: -4px; right: -4px;
        background: var(--danger, #dc2626); color: #fff;
        font-size: .6rem; font-weight: 700;
        min-width: 18px; height: 18px; border-radius: 9999px;
        display: flex; align-items: center; justify-content: center;
        padding: 0 4px; pointer-events: none; line-height: 1;
        border: 2px solid var(--surface, #fff);
      }
      #sw-badge.sw-gone { display: none; }

      /* Panel */
      #sw-panel {
        position: fixed; bottom: 88px; right: 24px;
        width: 340px; max-height: 560px;
        background: var(--surface, #fff);
        border: 1px solid var(--border, #e2e8f0);
        border-radius: 12px;
        box-shadow: 0 12px 40px rgba(0,0,0,.15);
        z-index: 8999; display: flex; flex-direction: column;
        overflow: hidden;
        transition: opacity .2s, transform .2s;
        transform-origin: bottom right;
      }
      #sw-panel.sw-gone {
        opacity: 0; transform: scale(.92) translateY(8px);
        pointer-events: none;
      }

      /* Header */
      #sw-header {
        background: var(--primary, #7FC571); color: #fff;
        padding: .75rem 1rem;
        display: flex; align-items: center; gap: .625rem;
        flex-shrink: 0;
      }
      .sw-hav {
        width: 34px; height: 34px; border-radius: 50%;
        background: rgba(255,255,255,.25);
        display: flex; align-items: center; justify-content: center;
        font-size: .75rem; font-weight: 700; flex-shrink: 0;
        overflow: hidden;
      }
      .sw-hav img { width: 100%; height: 100%; object-fit: cover; }
      .sw-hinfo { flex: 1; min-width: 0; }
      .sw-hname { font-size: .9rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .sw-hsub  { font-size: .7rem; opacity: .85; }
      .sw-hbtns { display: flex; gap: .25rem; }
      .sw-ibtn {
        background: transparent; border: none;
        color: rgba(255,255,255,.85); cursor: pointer;
        width: 28px; height: 28px; border-radius: 6px;
        display: flex; align-items: center; justify-content: center;
        font-size: .8rem; padding: 0;
        transition: background .15s, color .15s;
      }
      .sw-ibtn:hover        { background: rgba(255,255,255,.2); color: #fff; }
      .sw-ibtn:focus-visible { outline: 1px solid rgba(255,255,255,.7); }
      .sw-resolve-btn {
        background: rgba(255,255,255,.2);
        border: 1px solid rgba(255,255,255,.35);
        color: #fff;
        border-radius: 999px;
        font-size: .72rem;
        font-weight: 600;
        line-height: 1;
        padding: .35rem .65rem;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: .35rem;
      }
      .sw-resolve-btn:hover:not(:disabled) { background: rgba(255,255,255,.28); }
      .sw-resolve-btn:disabled { opacity: .75; cursor: default; }

      /* Resolved banner */
      #sw-res-banner {
        background: var(--success-light, #f0fdf4);
        color: var(--success, #16a34a);
        font-size: .75rem; padding: .375rem .75rem;
        text-align: center; flex-shrink: 0;
        border-bottom: 1px solid var(--border, #e2e8f0);
        display: flex; align-items: center; justify-content: center; gap: .375rem;
      }
      #sw-reopen-btn {
        background: none; border: none; padding: 0; margin-left: .25rem;
        color: var(--primary, #7FC571); cursor: pointer;
        font-size: .75rem; text-decoration: underline;
      }
      #sw-delete-btn {
        background: none; border: none; padding: 0; margin-left: .25rem;
        color: var(--danger, #dc2626); cursor: pointer;
        font-size: .75rem; text-decoration: underline;
      }

      /* Messages */
      #sw-msgs {
        flex: 1; overflow-y: auto; padding: .75rem;
        display: flex; flex-direction: column; gap: .5rem;
        scroll-behavior: smooth;
      }
      #sw-msgs::-webkit-scrollbar { width: 4px; }
      #sw-msgs::-webkit-scrollbar-thumb { background: var(--border, #e2e8f0); border-radius: 2px; }

      .sw-msg {
        display: flex; align-items: flex-end; gap: .375rem;
        max-width: 88%;
      }
      .sw-msg-u { align-self: flex-end; flex-direction: row-reverse; }
      .sw-msg-a { align-self: flex-start; }

      .sw-mav {
        width: 22px; height: 22px; border-radius: 50%;
        background: var(--primary-light, #edf7eb);
        color: var(--primary, #7FC571);
        display: flex; align-items: center; justify-content: center;
        font-size: .58rem; font-weight: 700; flex-shrink: 0; overflow: hidden;
      }
      .sw-mav img { width: 100%; height: 100%; object-fit: cover; }

      .sw-mbody {
        padding: .45rem .7rem; border-radius: 12px;
        font-size: .8rem; line-height: 1.45; word-break: break-word;
      }
      .sw-msg-a .sw-mbody {
        background: var(--bg, #f8fafc);
        border: 1px solid var(--border, #e2e8f0);
        color: var(--text, #1e293b);
        border-bottom-left-radius: 4px;
      }
      .sw-msg-u .sw-mbody {
        background: var(--primary, #7FC571);
        color: #fff;
        border-bottom-right-radius: 4px;
      }

      .sw-mmeta {
        font-size: .63rem; color: var(--text-muted, #64748b);
        margin-top: 2px; display: flex; align-items: center; gap: .2rem;
      }
      .sw-msg-u .sw-mmeta { justify-content: flex-end; }

      .sw-tick     { color: var(--text-muted, #64748b); }
      .sw-tick-r   { color: var(--primary, #7FC571); }

      /* Typing indicator */
      .sw-typing {
        align-self: flex-start;
        background: var(--bg, #f8fafc);
        border: 1px solid var(--border, #e2e8f0);
        border-radius: 12px; border-bottom-left-radius: 4px;
        padding: .45rem .7rem;
        display: flex; gap: 3px; align-items: center;
      }
      .sw-typing span {
        width: 6px; height: 6px;
        background: var(--text-muted, #64748b);
        border-radius: 50%;
        animation: sw-bounce 1.3s infinite ease-in-out;
      }
      .sw-typing span:nth-child(2) { animation-delay: .18s; }
      .sw-typing span:nth-child(3) { animation-delay: .36s; }
      @keyframes sw-bounce {
        0%,80%,100% { transform: translateY(0); opacity: .45; }
        40%          { transform: translateY(-5px); opacity: 1; }
      }

      /* Empty state */
      .sw-empty {
        flex: 1; display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        text-align: center; color: var(--text-muted, #64748b);
        font-size: .8rem; gap: .5rem; padding: 1.5rem 1rem;
      }
      .sw-empty i { font-size: 2.25rem; color: var(--primary-light, #edf7eb); margin-bottom: .25rem; }
      .sw-loading {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-muted, #64748b);
        font-size: .82rem;
        gap: .5rem;
      }
      .sw-spin {
        width: 14px;
        height: 14px;
        border: 2px solid var(--border, #e2e8f0);
        border-top-color: var(--primary, #7FC571);
        border-radius: 50%;
        animation: sw-spin .65s linear infinite;
      }
      @keyframes sw-spin { to { transform: rotate(360deg); } }

      /* Input row */
      #sw-input-row {
        padding: .5rem; border-top: 1px solid var(--border, #e2e8f0);
        display: flex; gap: .375rem; align-items: flex-end; flex-shrink: 0;
      }
      #sw-input {
        flex: 1; border: 1px solid var(--border, #e2e8f0);
        border-radius: 8px; padding: .45rem .65rem;
        font-size: .8rem; resize: none; max-height: 88px;
        color: var(--text, #1e293b); background: var(--surface, #fff);
        font-family: inherit; line-height: 1.4; outline: none;
        transition: border-color .15s, box-shadow .15s;
        overflow-y: auto;
      }
      #sw-input:focus {
        border-color: var(--primary, #7FC571);
        box-shadow: 0 0 0 3px rgba(127,197,113,.15);
      }
      #sw-input::placeholder { color: var(--text-muted, #64748b); }
      #sw-send {
        background: var(--primary, #7FC571); color: #fff;
        border: none; border-radius: 8px;
        width: 34px; height: 34px; flex-shrink: 0;
        display: flex; align-items: center; justify-content: center;
        cursor: pointer; font-size: .85rem; padding: 0;
        transition: background .15s;
      }
      #sw-send:hover:not(:disabled)  { background: var(--primary-hover, #6aaa5e); }
      #sw-send:disabled { opacity: .55; cursor: not-allowed; }

      /* Previous conversations */
      #sw-prev-wrap { border-top: 1px solid var(--border, #e2e8f0); flex-shrink: 0; }
      #sw-prev-toggle {
        width: 100%; background: transparent; border: none;
        padding: .45rem 1rem; font-size: .73rem;
        color: var(--text-muted, #64748b);
        cursor: pointer; display: flex; align-items: center;
        justify-content: space-between;
        transition: background .15s;
      }
      #sw-prev-toggle:hover { background: var(--bg, #f8fafc); }
      #sw-prev-list {
        max-height: 150px; overflow-y: auto;
        background: var(--bg, #f8fafc);
        border-top: 1px solid var(--border, #e2e8f0);
      }
      .sw-prev-item {
        padding: .45rem 1rem; cursor: pointer;
        border-bottom: 1px solid var(--border, #e2e8f0);
        font-size: .73rem; transition: background .15s;
        display: flex; flex-direction: column; gap: 2px;
        position: relative;
      }
      .sw-prev-item:last-child  { border-bottom: none; }
      .sw-prev-item:hover       { background: var(--primary-light, #edf7eb); }
      .sw-prev-item.sw-sel      { background: var(--primary-light, #edf7eb); }
      .sw-prev-date    { color: var(--text-muted, #64748b); font-size: .67rem; }
      .sw-prev-preview { color: var(--text, #1e293b); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .sw-prev-del {
        position: absolute;
        top: .3rem;
        right: .35rem;
        width: 18px;
        height: 18px;
        border: none;
        border-radius: 999px;
        background: transparent;
        color: var(--text-muted, #64748b);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: .65rem;
      }
      .sw-prev-del:hover { color: var(--danger, #dc2626); background: rgba(220,38,38,.08); }

      /* Back bar (inside message area when viewing past conv) */
      .sw-back-bar {
        display: flex; align-items: center; gap: .5rem;
        padding: .4rem .6rem; font-size: .73rem;
        color: var(--text-muted, #64748b);
        border-bottom: 1px solid var(--border, #e2e8f0);
        flex-shrink: 0; background: var(--bg, #f8fafc);
      }
      .sw-back-btn {
        background: none; border: none; padding: 0;
        color: var(--primary, #7FC571); cursor: pointer;
        font-size: .73rem; display: flex; align-items: center; gap: .25rem;
      }

      /* Toast */
      #sw-toast {
        position: fixed; bottom: 90px; right: 24px;
        background: var(--text, #1e293b); color: #fff;
        padding: 0; border-radius: 10px;
        font-size: .78rem; max-width: 280px; line-height: 1.4;
        z-index: 9001;
        box-shadow: 0 4px 14px rgba(0,0,0,.2);
        transition: opacity .3s, transform .3s;
        overflow: hidden;
      }
      #sw-toast.sw-gone { opacity: 0; transform: translateY(6px); pointer-events: none; }
      .sw-toast-inner {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: .25rem;
        align-items: start;
        padding: .6rem .7rem .5rem .8rem;
        cursor: pointer;
      }
      .sw-toast-text { overflow: hidden; text-overflow: ellipsis; }
      .sw-toast-close {
        border: none; background: transparent; color: rgba(255,255,255,.85);
        cursor: pointer; font-size: .8rem; line-height: 1; padding: .2rem;
      }
      .sw-toast-close:hover { color: #fff; }
      .sw-toast-progress {
        height: 3px;
        width: 100%;
        background: rgba(255,255,255,.35);
        transform-origin: left center;
        animation-name: sw-toast-progress;
        animation-timing-function: linear;
        animation-fill-mode: forwards;
      }
      @keyframes sw-toast-progress {
        from { transform: scaleX(1); }
        to   { transform: scaleX(0); }
      }

      @media (max-width: 420px) {
        #sw-panel { width: calc(100vw - 32px); right: 16px; bottom: 82px; }
        #sw-fab   { right: 16px; bottom: 16px; }
        #sw-toast { right: 16px; }
      }
    `;
    document.head.appendChild(s);
  }

  // ── DOM ───────────────────────────────────────────────────────────────
  function buildDOM() {
    // FAB
    const fab = el('button', { id: 'sw-fab', 'aria-label': 'Open support chat', 'aria-expanded': 'false' });
    fab.innerHTML = '<i class="fa-solid fa-comment-dots" aria-hidden="true"></i>';
    const badge = el('span', { id: 'sw-badge', class: 'sw-gone' });
    fab.appendChild(badge);

    // Panel
    const panel = el('div', { id: 'sw-panel', class: 'sw-gone', role: 'dialog', 'aria-label': 'Support chat' });
    panel.innerHTML = `
      <div id="sw-header">
        <div class="sw-hav" id="sw-hav"></div>
        <div class="sw-hinfo">
          <div class="sw-hname" id="sw-hname">${esc(_state.adminName)}</div>
          <div class="sw-hsub">Support</div>
        </div>
        <div class="sw-hbtns">
          <button class="sw-resolve-btn sw-gone" id="sw-resolve-btn" title="Mark conversation resolved">
            <span class="sw-resolve-label">Resolve</span>
          </button>
          <button class="sw-ibtn" id="sw-close-btn" title="Close" aria-label="Close chat">
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
          </button>
        </div>
      </div>

      <div id="sw-res-banner" class="sw-gone">
        <i class="fa-solid fa-circle-check" aria-hidden="true"></i>
        Conversation resolved
        <button id="sw-reopen-btn">Reopen</button>
        <button id="sw-delete-btn">Delete</button>
      </div>

      <div id="sw-msgs" role="log" aria-live="polite" aria-label="Chat messages"></div>

      <div id="sw-input-row">
        <textarea id="sw-input" rows="1" placeholder="Type a message…" aria-label="Message input"></textarea>
        <button id="sw-send" aria-label="Send message">
          <i class="fa-solid fa-paper-plane" aria-hidden="true"></i>
        </button>
      </div>

      <div id="sw-prev-wrap">
        <button id="sw-prev-toggle" aria-expanded="false">
          <span>Previous conversations</span>
          <i class="fa-solid fa-chevron-down" aria-hidden="true" id="sw-prev-chevron"></i>
        </button>
        <div id="sw-prev-list" class="sw-gone" role="list"></div>
      </div>
    `;

    // Toast
    const toast = el('div', { id: 'sw-toast', class: 'sw-gone', role: 'alert', 'aria-live': 'assertive' });
    toast.innerHTML = `
      <div class="sw-toast-inner" id="sw-toast-open">
        <div class="sw-toast-text" id="sw-toast-text"></div>
        <button class="sw-toast-close" id="sw-toast-close" aria-label="Dismiss notification">
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
      </div>
      <div class="sw-toast-progress" id="sw-toast-progress"></div>
    `;

    document.body.appendChild(fab);
    document.body.appendChild(panel);
    document.body.appendChild(toast);

    setAdminAvatar();
  }

  function el(tag, attrs = {}) {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
    return node;
  }

  function setAdminAvatar() {
    const av = document.getElementById('sw-hav');
    if (!av) return;
    av.textContent = initials(_state.adminName);
  }

  // ── Events ────────────────────────────────────────────────────────────
  function attachEvents() {
    document.getElementById('sw-fab').addEventListener('click', () => openPanel(!_state.open));
    document.getElementById('sw-close-btn').addEventListener('click', () => openPanel(false));

    const input = document.getElementById('sw-input');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
    });
    input.addEventListener('input', onInputChange);

    document.getElementById('sw-send').addEventListener('click', sendMsg);
    document.getElementById('sw-resolve-btn').addEventListener('click', resolveConv);
    document.getElementById('sw-reopen-btn').addEventListener('click', reopenConv);
    document.getElementById('sw-delete-btn').addEventListener('click', () => {
      const id = _state.conversation?.id;
      if (id) deleteConv(id);
    });
    document.getElementById('sw-prev-toggle').addEventListener('click', togglePrev);
    document.getElementById('sw-toast-open').addEventListener('click', () => {
      hideToast();
      openPanel(true);
    });
    document.getElementById('sw-toast-close').addEventListener('click', (event) => {
      event.stopPropagation();
      hideToast();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && _state.open) openPanel(false);
    });
  }

  function onInputChange() {
    const input = document.getElementById('sw-input');
    // Auto-resize
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 88) + 'px';

    // Typing indicator
    if (!_state.isTyping) {
      _state.isTyping = true;
      apiFetch('user-typing', { method: 'POST', body: JSON.stringify({ typing: true }) })
        .catch(() => {});
    }
    clearTimeout(_state.typingTimer);
    _state.typingTimer = setTimeout(() => {
      _state.isTyping = false;
      apiFetch('user-typing', { method: 'POST', body: JSON.stringify({ typing: false }) })
        .catch(() => {});
    }, TYPING_S);
  }

  // ── Panel open/close ──────────────────────────────────────────────────
  async function openPanel(open) {
    _state.open = open;
    const panel = document.getElementById('sw-panel');
    const fab   = document.getElementById('sw-fab');

    if (open) {
      panel.classList.remove('sw-gone');
      fab.setAttribute('aria-expanded', 'true');
      hideToast();
      _state.selectedPrevId = null;
      _state.loading = true;
      renderMessages();
      await loadMessages(true);
      focusInput();
    } else {
      panel.classList.add('sw-gone');
      fab.setAttribute('aria-expanded', 'false');
    }
  }

  function focusInput() {
    setTimeout(() => {
      const input = document.getElementById('sw-input');
      if (input && !_state.selectedPrevId) input.focus();
    }, 60);
  }

  // ── Load messages ─────────────────────────────────────────────────────
  async function loadMessages(markRead = false) {
    try {
      _state.loading = true;
      if (_state.open) renderMessages();
      const ep = (markRead && _state.open)
        ? 'support-messages?mark_read=1'
        : 'support-messages';
      const res = await apiFetch(ep);
      if (!res.ok) return;
      const data = await res.json();

      const prevUnread = _state.unread;

      _state.conversation   = data.conversation;
      _state.messages       = data.messages || [];
      _state.prevConvs      = data.previous_conversations || [];
      _state.adminName      = data.admin_name   || 'Support';
      _state.userName       = data.user_name    || null;
      _state.adminTypingAt  = data.admin_typing_at || null;
      _state.unread         = data.unread_count || 0;

      // Toast for new messages when panel is closed
      if (!_state.open && _state.unread > prevUnread) {
        const lastAdmin = [..._state.messages].reverse().find(m => m.from_admin);
        if (lastAdmin) {
          showToast(`${_state.adminName}: ${lastAdmin.body}`);
        }
      }

      updateBadge();
      renderMessages();
      renderPrevList();
      setAdminAvatar();
      document.getElementById('sw-hname').textContent = _state.adminName;
      updateResolvedUI();
    } catch (err) {
      console.warn('[support-widget] loadMessages error:', err);
    } finally {
      _state.loading = false;
      if (_state.open) renderMessages();
    }
  }

  function startPolling() {
    clearInterval(_state.pollTimer);
    _state.pollTimer = setInterval(() => loadMessages(_state.open), POLL_MS);
  }

  function startPresencePing() {
    clearInterval(_state.presenceTimer);
    const ping = () => apiFetch('ping-session').catch(() => {});
    ping();
    _state.presenceTimer = setInterval(ping, PRESENCE_MS);
  }

  // ── Render messages ───────────────────────────────────────────────────
  function renderMessages() {
    const container = document.getElementById('sw-msgs');
    if (!container) return;

    if (_state.loading) {
      container.innerHTML = '<div class="sw-loading"><span class="sw-spin" aria-hidden="true"></span><span>Loading…</span></div>';
      return;
    }

    // Viewing a specific past conversation
    if (_state.selectedPrevId) {
      renderPastConv(container, _state.selectedPrevId);
      return;
    }

    // No conversation and no messages yet
    if (!_state.conversation && _state.messages.length === 0) {
      container.innerHTML = `
        <div class="sw-empty">
          <i class="fa-regular fa-comments" aria-hidden="true"></i>
          <span>No messages yet.<br>Send us a message and we'll get back to you!</span>
        </div>`;
      return;
    }

    const atBottom    = nearBottom(container);
    const renderedMsgs = _state.messages.map(msgHtml).join('');
    const typing   = isAdminTyping()
      ? `<div class="sw-typing" aria-label="${esc(_state.adminName)} is typing">
           <span></span><span></span><span></span>
         </div>` : '';

    container.innerHTML = renderedMsgs + typing;
    if (atBottom) container.scrollTop = container.scrollHeight;
  }

  function msgHtml(m) {
    const isUser = !m.from_admin;
    const cls    = isUser ? 'sw-msg sw-msg-u' : 'sw-msg sw-msg-a';
    const name   = isUser ? (_state.userName || 'You') : _state.adminName;
    const av     = initials(name);
    const time   = fmtTime(m.created_at);

    let receipt = '';
    if (isUser) {
      const read = !!m.read_at;
      receipt = `<i class="fa-solid fa-check-double sw-tick${read ? '-r' : ''}" title="${read ? 'Read' : 'Sent'}" aria-label="${read ? 'Read' : 'Sent'}"></i>`;
    }

    return `
      <div class="${cls}">
        <div class="sw-mav">${av}</div>
        <div>
          <div class="sw-mbody">${esc(m.body)}</div>
          <div class="sw-mmeta">${esc(time)} ${receipt}</div>
        </div>
      </div>`;
  }

  async function renderPastConv(container, convId) {
    // Show cached or fetch
    if (_state.prevMsgCache[convId]) {
      drawPastMsgs(container, convId, _state.prevMsgCache[convId]);
      return;
    }

    container.innerHTML = `
      <div class="sw-back-bar">
        <button class="sw-back-btn" id="sw-back-btn">
          <i class="fa-solid fa-arrow-left" aria-hidden="true"></i> Back
        </button>
        <span>Loading…</span>
      </div>`;

    document.getElementById('sw-back-btn')?.addEventListener('click', backToActive);

    try {
      const res = await apiFetch(`support-messages?conversation_id=${encodeURIComponent(convId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      _state.prevMsgCache[convId] = data.messages || [];
      drawPastMsgs(container, convId, _state.prevMsgCache[convId]);
    } catch (err) {
      container.innerHTML = `<div class="sw-empty"><span>Failed to load messages.</span></div>`;
    }
  }

  function drawPastMsgs(container, convId, messages) {
    const conv     = _state.prevConvs.find(c => c.id === convId);
    const dateStr  = conv ? fmtDate(conv.resolved_at || conv.created_at) : '';
    const actions  = conv && conv.resolved
      ? `<span style="margin-left:auto;display:inline-flex;gap:.5rem;">
           <button class="sw-back-btn" id="sw-prev-reopen-btn">Reopen</button>
           <button class="sw-back-btn" id="sw-prev-delete-btn" style="color:var(--danger,#dc2626)">Delete</button>
         </span>`
      : '';
    const msgsHtml = messages.length
      ? messages.map(msgHtml).join('')
      : '<div class="sw-empty"><span>No messages in this conversation.</span></div>';

    container.innerHTML = `
      <div class="sw-back-bar">
        <button class="sw-back-btn" id="sw-back-btn">
          <i class="fa-solid fa-arrow-left" aria-hidden="true"></i> Back
        </button>
        <span>Resolved ${esc(dateStr)}</span>
        ${actions}
      </div>
      <div style="flex:1;overflow-y:auto;padding:.75rem;display:flex;flex-direction:column;gap:.5rem;">
        ${msgsHtml}
      </div>`;

    document.getElementById('sw-back-btn')?.addEventListener('click', backToActive);
    document.getElementById('sw-prev-reopen-btn')?.addEventListener('click', () => reopenSpecificConv(convId));
    document.getElementById('sw-prev-delete-btn')?.addEventListener('click', () => deleteConv(convId));
  }

  function backToActive() {
    _state.selectedPrevId = null;
    renderMessages();
    renderPrevList();
  }

  // ── Previous conversations list ───────────────────────────────────────
  function renderPrevList() {
    const list = document.getElementById('sw-prev-list');
    if (!list || !_state.showPrev) return;

    if (_state.prevConvs.length === 0) {
      list.innerHTML = '<div style="padding:.45rem 1rem;font-size:.73rem;color:var(--text-muted)">No previous conversations.</div>';
      return;
    }

    list.innerHTML = _state.prevConvs.map(c => `
      <div class="sw-prev-item${_state.selectedPrevId === c.id ? ' sw-sel' : ''}"
           role="listitem" data-id="${esc(c.id)}">
        <button class="sw-prev-del" data-del-id="${esc(c.id)}" title="Delete conversation" aria-label="Delete conversation">
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
        <span class="sw-prev-date">${esc(fmtDate(c.resolved_at || c.created_at))} · Resolved</span>
        <span class="sw-prev-preview">${esc(c.last_message?.body || 'No messages')}</span>
      </div>`).join('');

    list.querySelectorAll('.sw-prev-item').forEach(item => {
      item.addEventListener('click', () => {
        _state.selectedPrevId = item.dataset.id;
        renderMessages();
        renderPrevList();
      });
    });

    list.querySelectorAll('.sw-prev-del').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        deleteConv(btn.dataset.delId);
      });
    });
  }

  // ── Conversation actions ──────────────────────────────────────────────
  async function resolveConv() {
    const id = _state.conversation?.id;
    if (!id) return;
    const btn = document.getElementById('sw-resolve-btn');
    const label = btn?.querySelector('.sw-resolve-label');
    if (btn) btn.disabled = true;
    if (label) label.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Resolving';
    try {
      await apiFetch('support-conversations', {
        method: 'POST',
        body: JSON.stringify({ action: 'resolve_own', conversation_id: id }),
      });
      await loadMessages(false);
    } catch (err) {
      console.warn('[support-widget] resolveConv error:', err);
    } finally {
      if (btn) btn.disabled = false;
      if (label) label.textContent = 'Resolve';
    }
  }

  async function reopenConv() {
    const id = _state.conversation?.id;
    if (!id) return;
    await reopenSpecificConv(id);
  }

  async function reopenSpecificConv(id) {
    if (!id) return;
    try {
      await apiFetch('support-conversations', {
        method: 'POST',
        body: JSON.stringify({ action: 'reopen_own', conversation_id: id }),
      });
      _state.selectedPrevId = null;
      await loadMessages(false);
    } catch (err) {
      console.warn('[support-widget] reopenConv error:', err);
    }
  }

  async function deleteConv(id) {
    if (!id) return;
    if (!window.confirm('Delete this conversation and all messages? This cannot be undone.')) {
      return;
    }
    try {
      await apiFetch('support-conversations', {
        method: 'POST',
        body: JSON.stringify({ action: 'delete_own', conversation_id: id }),
      });
      _state.selectedPrevId = null;
      delete _state.prevMsgCache[id];
      await loadMessages(false);
    } catch (err) {
      console.warn('[support-widget] deleteConv error:', err);
    }
  }

  // ── Send message ──────────────────────────────────────────────────────
  async function sendMsg() {
    const input   = document.getElementById('sw-input');
    const sendBtn = document.getElementById('sw-send');
    const text    = (input?.value || '').trim();
    if (!text) return;

    sendBtn.disabled  = true;
    input.value       = '';
    input.style.height = 'auto';

    // Stop typing indicator
    clearTimeout(_state.typingTimer);
    if (_state.isTyping) {
      _state.isTyping = false;
      apiFetch('user-typing', { method: 'POST', body: JSON.stringify({ typing: false }) })
        .catch(() => {});
    }

    try {
      const res = await apiFetch('support-messages', {
        method: 'POST',
        body:   JSON.stringify({ message: text }),
      });
      if (res.ok) await loadMessages(true);
    } catch (err) {
      console.warn('[support-widget] sendMsg error:', err);
    } finally {
      sendBtn.disabled = false;
      focusInput();
    }
  }

  // ── UI helpers ────────────────────────────────────────────────────────
  function updateBadge() {
    const badge = document.getElementById('sw-badge');
    if (!badge) return;
    if (_state.unread > 0 && !_state.open) {
      badge.textContent = _state.unread > 99 ? '99+' : String(_state.unread);
      badge.classList.remove('sw-gone');
    } else {
      badge.classList.add('sw-gone');
    }
  }

  function updateResolvedUI() {
    const banner   = document.getElementById('sw-res-banner');
    const inputRow = document.getElementById('sw-input-row');
    const resBtn   = document.getElementById('sw-resolve-btn');

    const viewingPast = !!_state.selectedPrevId;
    const resolved = _state.conversation?.resolved === true;
    const hasConv  = !!_state.conversation;

    toggleGone(banner,   !(resolved && !viewingPast));
    toggleGone(inputRow,  resolved || viewingPast);
    toggleGone(resBtn,   !(hasConv && !resolved && !viewingPast));
  }

  function togglePrev() {
    _state.showPrev = !_state.showPrev;
    const list    = document.getElementById('sw-prev-list');
    const toggle  = document.getElementById('sw-prev-toggle');
    const chevron = document.getElementById('sw-prev-chevron');

    toggleGone(list, !_state.showPrev);
    toggle?.setAttribute('aria-expanded', String(_state.showPrev));

    if (chevron) {
      chevron.className = _state.showPrev
        ? 'fa-solid fa-chevron-up'
        : 'fa-solid fa-chevron-down';
    }

    if (_state.showPrev) renderPrevList();
  }

  function toggleGone(node, gone) {
    if (!node) return;
    if (gone) { node.classList.add('sw-gone'); }
    else       { node.classList.remove('sw-gone'); }
  }

  function isAdminTyping() {
    if (!_state.adminTypingAt) return false;
    return (Date.now() - new Date(_state.adminTypingAt).getTime()) < ADMIN_TYPING_TTL;
  }

  function nearBottom(el) {
    return (el.scrollHeight - el.clientHeight - el.scrollTop) < 50;
  }

  // ── Toast ─────────────────────────────────────────────────────────────
  function showToast(text) {
    const toast = document.getElementById('sw-toast');
    const toastText = document.getElementById('sw-toast-text');
    const progress = document.getElementById('sw-toast-progress');
    if (!toast) return;
    if (toastText) toastText.textContent = text;
    if (progress) {
      progress.style.animation = 'none';
      // Force reflow so the animation reliably restarts.
      void progress.offsetHeight;
      progress.style.animation = `sw-toast-progress ${TOAST_MS}ms linear forwards`;
    }
    toast.classList.remove('sw-gone');
    clearTimeout(_state.toastTimer);
    _state.toastTimer = setTimeout(hideToast, TOAST_MS);
  }

  function hideToast() {
    document.getElementById('sw-toast')?.classList.add('sw-gone');
  }

  // ── Utils ─────────────────────────────────────────────────────────────
  function esc(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function initials(name) {
    if (!name) return '?';
    return name.split(/\s+/).filter(Boolean).slice(0, 2)
      .map(w => w[0].toUpperCase()).join('');
  }

  function fmtTime(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
  }

  function fmtDate(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleDateString(undefined,
        { month: 'short', day: 'numeric', year: 'numeric' });
    } catch { return ''; }
  }
})();
