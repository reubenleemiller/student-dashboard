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
  const API            = '/.netlify/functions';
  const POLL_MS        = 5000;   // Message polling interval (ms)
  const TYPING_S       = 3000;   // Typing-stop debounce (ms)
  const TOAST_MS       = 6000;   // Toast auto-hide duration (ms)
  const ADMIN_TYPING_TTL = 8000; // How long to show "admin typing" (ms)
  const PRESENCE_MS    = 60000;
  const MIN_SPINNER_MS = 2000;   // Minimum ms to show loading overlay (matches StudyGuide-Template)
  const MAX_TOAST_PREVIEW = 60;  // Maximum characters in toast preview before truncation

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
    pendingDeleteId: null,
    deleteTriggerEl: null,
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
    panelOpenTime:  0,        // Timestamp when panel was last opened
    overlayReady:   false,    // True once the initial load after open is done
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
      await loadMessages(false, true);
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
        min-width: 20px; height: 20px; border-radius: 10px;
        display: flex; align-items: center; justify-content: center;
        padding: 0 4px; pointer-events: none; line-height: 1;
        border: 2px solid var(--surface, #fff);
        box-shadow: 0 0 0 2px #fff;
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
        opacity: 0; transform: translateY(20px) scale(0.96);
        pointer-events: none;
        transition: opacity 0.22s ease, transform 0.22s cubic-bezier(0.34,1.56,0.64,1);
        transform-origin: bottom right;
      }
      #sw-panel.sw-open {
        opacity: 1; transform: translateY(0) scale(1);
        pointer-events: auto;
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

      /* Full-panel loading overlay (shown on first open, min 2 s) */
      #sw-overlay {
        position: absolute; inset: 0; z-index: 10;
        background: rgba(255,255,255,0.88);
        backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
        display: flex; flex-direction: column;
        align-items: center; justify-content: center; gap: .75rem;
        border-radius: 12px;
        opacity: 0; pointer-events: none;
        transition: opacity 0.2s ease;
      }
      #sw-overlay.sw-overlay-visible { opacity: 1; pointer-events: auto; }
      .sw-overlay-spinner {
        width: 2rem; height: 2rem;
        border: 3px solid rgba(127,197,113,0.2);
        border-top-color: var(--primary, #7FC571);
        border-radius: 50%; animation: sw-spin 0.8s linear infinite;
      }
      .sw-overlay-text {
        font-size: .875rem; color: var(--text-muted, #64748b);
        font-family: inherit;
      }

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
      #sw-prev-wrap {
        border-bottom: 1px solid var(--border, #e2e8f0);
        flex-shrink: 0;
      }
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
        max-height: 260px; overflow-y: auto;
        background: var(--bg, #f8fafc);
        border-top: 1px solid var(--border, #e2e8f0);
        padding: .4rem .6rem;
        display: flex; flex-direction: column; gap: .4rem;
      }
      .sw-prev-section {
        border: 1px solid var(--border, #e2e8f0);
        border-radius: 8px;
        overflow: hidden;
        background: var(--surface, #fff);
      }
      .sw-prev-header {
        display: flex; align-items: center; gap: .4rem;
        padding: .45rem .75rem;
        cursor: pointer; user-select: none;
        font-size: .73rem; font-weight: 600;
        color: var(--text-muted, #64748b);
        border-bottom: 1px solid var(--border, #e2e8f0);
        background: var(--bg, #f8fafc);
        transition: background .15s;
      }
      .sw-prev-header:hover { background: var(--primary-light, #edf7eb); }
      .sw-prev-chevron { margin-left: auto; font-size: .65rem; transition: transform .2s; }
      .sw-prev-chevron.sw-chev-open { transform: rotate(180deg); }
      .sw-prev-msgs-content {
        display: none;
        max-height: 160px; overflow-y: auto;
        padding: .4rem .5rem;
        flex-direction: column; gap: .35rem;
      }
      .sw-prev-msgs-content.sw-open { display: flex; }
      .sw-prev-actions {
        display: flex; gap: .35rem;
        padding: .35rem .5rem;
        border-top: 1px solid var(--border, #e2e8f0);
        flex-wrap: wrap;
      }
      .sw-prev-btn {
        font-size: .72rem; padding: .2rem .65rem;
        border: 1px solid var(--border, #e2e8f0);
        border-radius: 12px; background: var(--surface, #fff);
        cursor: pointer; color: var(--text-muted, #64748b);
        font-family: inherit;
        display: inline-flex; align-items: center; gap: .25rem;
        transition: border-color .15s, background .15s, color .15s;
      }
      .sw-prev-btn:hover { border-color: #999; color: var(--text, #1e293b); }
      .sw-prev-danger { border-color: var(--danger, #dc2626); color: var(--danger, #dc2626); }
      .sw-prev-danger:hover { background: var(--danger, #dc2626); color: #fff; }
      .sw-prev-btn:disabled { opacity: .5; cursor: not-allowed; }

      /* Delete modal */
      #sw-delete-modal {
        position: fixed;
        inset: 0;
        z-index: 9002;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1rem;
      }
      .sw-delete-modal-backdrop {
        position: absolute;
        inset: 0;
        background: rgba(15, 23, 42, .55);
        backdrop-filter: blur(2px);
      }
      .sw-delete-modal-card {
        position: relative;
        width: min(320px, calc(100vw - 2rem));
        background: var(--surface, #fff);
        border: 1px solid var(--border, #e2e8f0);
        border-radius: 16px;
        box-shadow: 0 18px 60px rgba(0, 0, 0, .22);
        padding: 1rem;
        color: var(--text, #1e293b);
      }
      .sw-delete-modal-close {
        position: absolute;
        top: .6rem;
        right: .6rem;
        width: 30px;
        height: 30px;
        border: none;
        border-radius: 999px;
        background: transparent;
        color: var(--text-muted, #64748b);
        cursor: pointer;
      }
      .sw-delete-modal-close:hover { background: var(--bg, #f8fafc); }
      .sw-delete-modal-icon {
        width: 42px;
        height: 42px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(220, 38, 38, .1);
        color: var(--danger, #dc2626);
        margin-bottom: .75rem;
      }
      .sw-delete-modal-title {
        margin: 0 2rem .4rem 0;
        font-size: .98rem;
        line-height: 1.3;
      }
      .sw-delete-modal-copy {
        margin: 0;
        color: var(--text-muted, #64748b);
        font-size: .84rem;
        line-height: 1.45;
      }
      .sw-delete-modal-actions {
        display: flex;
        gap: .5rem;
        justify-content: flex-end;
        margin-top: 1rem;
      }
      .sw-delete-modal-btn {
        border-radius: 10px;
        border: 1px solid var(--border, #e2e8f0);
        padding: .55rem .85rem;
        font-size: .82rem;
        cursor: pointer;
      }
      .sw-delete-modal-btn.secondary {
        background: var(--surface, #fff);
        color: var(--text, #1e293b);
      }
      .sw-delete-modal-btn.primary {
        background: var(--danger, #dc2626);
        border-color: var(--danger, #dc2626);
        color: #fff;
      }
      .sw-delete-modal-btn.primary:hover { filter: brightness(.96); }

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
        background: #fff; color: var(--text, #1e293b);
        border: 1px solid rgba(0,0,0,0.09);
        border-radius: 14px;
        box-shadow: 0 6px 28px rgba(0,0,0,.15), 0 2px 8px rgba(0,0,0,.08);
        max-width: 290px; width: calc(100vw - 3rem);
        z-index: 9001; overflow: hidden;
        display: flex; align-items: flex-start; gap: .6rem;
        padding: .7rem .85rem;
        cursor: pointer;
        opacity: 0; transform: translateY(16px) scale(0.97); pointer-events: none;
        transition: opacity 0.22s ease, transform 0.22s cubic-bezier(0.34,1.56,0.64,1);
      }
      #sw-toast.sw-toast-visible {
        opacity: 1; transform: translateY(0) scale(1); pointer-events: auto;
      }
      .sw-toast-avatar {
        flex-shrink: 0;
        width: 32px; height: 32px; border-radius: 50%;
        background: var(--primary-light, #edf7eb);
        color: var(--primary, #7FC571);
        display: flex; align-items: center; justify-content: center;
        font-size: .65rem; font-weight: 700;
        overflow: hidden;
      }
      .sw-toast-body { flex: 1; min-width: 0; }
      .sw-toast-sender {
        font-size: .74rem; font-weight: 700; color: #333;
        margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .sw-toast-preview {
        font-size: .82rem; color: #555;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .sw-toast-close {
        flex-shrink: 0; align-self: flex-start;
        border: none; background: transparent; color: #bbb;
        cursor: pointer; font-size: .8rem; padding: 0; line-height: 1;
        transition: color 0.15s;
      }
      .sw-toast-close:hover { color: #555; }
      .sw-toast-bar {
        position: absolute; bottom: 0; left: 0; height: 3px;
        background: var(--primary, #7FC571); border-radius: 0 0 14px 14px;
        width: 100%; transform-origin: left; transition: transform linear;
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

    // Panel — use opacity/pointer-events (not display:none) so spring animation works
    const panel = el('div', { id: 'sw-panel', role: 'dialog', 'aria-label': 'Support chat' });
    panel.innerHTML = `
      <div id="sw-overlay" aria-live="polite" aria-label="Loading chat">
        <div class="sw-overlay-spinner" aria-hidden="true"></div>
        <span class="sw-overlay-text">Connecting…</span>
      </div>

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

      <div id="sw-prev-wrap">
        <button id="sw-prev-toggle" aria-expanded="false">
          <span>Previous conversations</span>
          <i class="fa-solid fa-chevron-down" aria-hidden="true" id="sw-prev-chevron"></i>
        </button>
        <div id="sw-prev-list" class="sw-gone" role="list"></div>
      </div>

      <div id="sw-res-banner" class="sw-gone">
        <i class="fa-solid fa-circle-check" aria-hidden="true"></i>
        Conversation resolved — type below to start a new one.
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
    `;

    const deleteModal = el('div', { id: 'sw-delete-modal', class: 'sw-gone', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sw-delete-modal-title' });
    deleteModal.innerHTML = `
      <div class="sw-delete-modal-backdrop" data-sw-delete-close="true"></div>
      <div class="sw-delete-modal-card">
        <button class="sw-delete-modal-close" id="sw-delete-modal-close" aria-label="Close delete dialog">
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
        <div class="sw-delete-modal-icon" aria-hidden="true">
          <i class="fa-solid fa-triangle-exclamation"></i>
        </div>
        <h2 class="sw-delete-modal-title" id="sw-delete-modal-title">Delete this resolved conversation?</h2>
        <p class="sw-delete-modal-copy">This will permanently remove the conversation and all of its messages. You can dismiss this dialog without deleting anything.</p>
        <div class="sw-delete-modal-actions">
          <button type="button" class="sw-delete-modal-btn secondary" id="sw-delete-modal-cancel">Cancel</button>
          <button type="button" class="sw-delete-modal-btn primary" id="sw-delete-modal-confirm">Delete conversation</button>
        </div>
      </div>
    `;

    // Toast — white card with avatar, sender name, preview, progress bar
    // Does NOT use sw-gone (display:none) so the CSS opacity/transform transition works
    const toast = el('div', { id: 'sw-toast', role: 'alert', 'aria-live': 'assertive', 'aria-atomic': 'true' });
    toast.innerHTML = `
      <div class="sw-toast-avatar" id="sw-toast-avatar"></div>
      <div class="sw-toast-body" id="sw-toast-open">
        <div class="sw-toast-sender" id="sw-toast-sender"></div>
        <div class="sw-toast-preview" id="sw-toast-preview"></div>
      </div>
      <button class="sw-toast-close" id="sw-toast-close" aria-label="Dismiss notification">
        <i class="fa-solid fa-xmark" aria-hidden="true"></i>
      </button>
      <div class="sw-toast-bar" id="sw-toast-bar"></div>
    `;

    document.body.appendChild(fab);
    document.body.appendChild(panel);
    document.body.appendChild(deleteModal);
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
    document.getElementById('sw-delete-btn').addEventListener('click', (event) => {
      const id = _state.conversation?.id;
      if (id) openDeleteModal(id, event.currentTarget);
    });
    document.getElementById('sw-prev-toggle').addEventListener('click', togglePrev);
    document.getElementById('sw-delete-modal-close').addEventListener('click', closeDeleteModal);
    document.getElementById('sw-delete-modal-cancel').addEventListener('click', closeDeleteModal);
    document.getElementById('sw-delete-modal-confirm').addEventListener('click', confirmDeleteConv);
    document.getElementById('sw-delete-modal').addEventListener('click', (event) => {
      if (event.target?.dataset?.swDeleteClose === 'true') closeDeleteModal();
    });
    // Clicking the toast body opens chat; close button dismisses
    document.getElementById('sw-toast').addEventListener('click', (event) => {
      const closeBtn = document.getElementById('sw-toast-close');
      if (event.target === closeBtn || closeBtn?.contains(event.target)) return;
      hideToast();
      openPanel(true);
    });
    document.getElementById('sw-toast-close').addEventListener('click', (event) => {
      event.stopPropagation();
      hideToast();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!document.getElementById('sw-delete-modal')?.classList.contains('sw-gone')) {
        closeDeleteModal();
        return;
      }
      if (_state.open) openPanel(false);
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
      // Use rAF so the browser renders the panel at its initial (opacity:0) state
      // first, allowing the spring transition to play from the start position.
      requestAnimationFrame(() => panel.classList.add('sw-open'));
      fab.setAttribute('aria-expanded', 'true');
      hideToast();
      _state.loading = true;
      _state.panelOpenTime = Date.now();
      _state.overlayReady = false;
      showLoadingOverlay();
      renderMessages();
      await loadMessages(true, true);
      focusInput();
    } else {
      panel.classList.remove('sw-open');
      fab.setAttribute('aria-expanded', 'false');
    }
  }

  function showLoadingOverlay() {
    const overlay = document.getElementById('sw-overlay');
    if (overlay) overlay.classList.add('sw-overlay-visible');
  }

  function hideLoadingOverlay() {
    const overlay = document.getElementById('sw-overlay');
    if (!overlay) return;
    const elapsed = Date.now() - _state.panelOpenTime;
    const remaining = MIN_SPINNER_MS - elapsed;
    const doHide = () => {
      overlay.classList.remove('sw-overlay-visible');
      _state.overlayReady = true;
      if (_state.open) focusInput();
    };
    if (remaining > 0) {
      setTimeout(doHide, remaining);
    } else {
      doHide();
    }
  }

  function focusInput() {
    setTimeout(() => {
      const input = document.getElementById('sw-input');
      if (input) input.focus();
    }, 60);
  }

  // ── Load messages ─────────────────────────────────────────────────────
  async function loadMessages(markRead = false, showLoading = false) {
    try {
      if (showLoading) {
        _state.loading = true;
        if (_state.open) renderMessages();
      }
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
          const preview = (lastAdmin.body || '').trim();
          showToast(_state.adminName, preview.length > MAX_TOAST_PREVIEW ? preview.slice(0, MAX_TOAST_PREVIEW) + '…' : preview);
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
      if (showLoading) {
        _state.loading = false;
        if (_state.open) renderMessages();
        hideLoadingOverlay();
      }
    }
  }

  function startPolling() {
    clearInterval(_state.pollTimer);
    _state.pollTimer = setInterval(() => loadMessages(_state.open, false), POLL_MS);
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

  // ── Previous conversations accordion helpers ─────────────────────────
  function buildPrevConvSection(conv) {
    const convId  = conv.id;
    const dateStr = fmtDate(conv.resolved_at || conv.created_at);

    const section = document.createElement('div');
    section.className = 'sw-prev-section';

    const header = document.createElement('div');
    header.className = 'sw-prev-header';
    header.setAttribute('role', 'button');
    header.setAttribute('aria-expanded', 'false');
    header.setAttribute('tabindex', '0');
    header.innerHTML =
      '<i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i>' +
      '<span>Previous Conversation \u00b7 ' + esc(dateStr) + '</span>' +
      '<i class="fa-solid fa-chevron-down sw-prev-chevron" aria-hidden="true"></i>';

    const msgsDiv = document.createElement('div');
    msgsDiv.className = 'sw-prev-msgs-content';

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'sw-prev-actions sw-gone';

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'sw-prev-btn sw-prev-danger';
    deleteBtn.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i> Delete';
    deleteBtn.title = 'Permanently delete this conversation';
    deleteBtn.addEventListener('click', () => openDeleteModal(convId, deleteBtn));

    const reopenBtn = document.createElement('button');
    reopenBtn.className = 'sw-prev-btn';
    reopenBtn.innerHTML = '<i class="fa-solid fa-reply" aria-hidden="true"></i> Reopen';
    reopenBtn.title = 'Reopen this conversation to continue it';
    reopenBtn.addEventListener('click', () => reopenSpecificConv(convId));
    if (!conv.resolved) reopenBtn.style.display = 'none';

    actionsDiv.appendChild(deleteBtn);
    if (conv.resolved) actionsDiv.appendChild(reopenBtn);

    function toggle() {
      const open = msgsDiv.classList.contains('sw-open');
      const chev = header.querySelector('.sw-prev-chevron');
      if (open) {
        msgsDiv.classList.remove('sw-open');
        toggleGone(actionsDiv, true);
        if (chev) chev.classList.remove('sw-chev-open');
        header.setAttribute('aria-expanded', 'false');
      } else {
        msgsDiv.classList.add('sw-open');
        toggleGone(actionsDiv, false);
        if (chev) chev.classList.add('sw-chev-open');
        header.setAttribute('aria-expanded', 'true');
        if (!_state.prevMsgCache[convId]) {
          loadPrevMsgsAccordion(msgsDiv, convId);
        } else {
          renderPrevMsgsAccordion(msgsDiv, _state.prevMsgCache[convId]);
        }
      }
    }

    header.addEventListener('click', toggle);
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });

    section.appendChild(header);
    section.appendChild(msgsDiv);
    section.appendChild(actionsDiv);
    return section;
  }

  async function loadPrevMsgsAccordion(container, convId) {
    container.innerHTML = '<div class="sw-loading"><span class="sw-spin" aria-hidden="true"></span><span>Loading\u2026</span></div>';
    try {
      const res = await apiFetch(`support-messages?conversation_id=${encodeURIComponent(convId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      _state.prevMsgCache[convId] = data.messages || [];
      renderPrevMsgsAccordion(container, _state.prevMsgCache[convId]);
    } catch (err) {
      container.innerHTML = '<div class="sw-empty"><span>Failed to load messages.</span></div>';
    }
  }

  function renderPrevMsgsAccordion(container, messages) {
    if (!messages.length) {
      container.innerHTML = '<div class="sw-empty"><span>No messages in this conversation.</span></div>';
      return;
    }
    container.innerHTML = messages.map(msgHtml).join('');
  }

  // ── Previous conversations list ───────────────────────────────────────
  function renderPrevList() {
    const list = document.getElementById('sw-prev-list');
    if (!list || !_state.showPrev) return;

    if (_state.prevConvs.length === 0) {
      list.innerHTML = '<div style="padding:.45rem 1rem;font-size:.73rem;color:var(--text-muted)">No previous conversations.</div>';
      return;
    }

    list.innerHTML = '';
    _state.prevConvs.forEach(conv => list.appendChild(buildPrevConvSection(conv)));
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
      await loadMessages(false, false);
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
      await loadMessages(false, false);
    } catch (err) {
      console.warn('[support-widget] reopenConv error:', err);
    }
  }

  async function deleteConv(id) {
    if (!id) return;
    try {
      await apiFetch('support-conversations', {
        method: 'POST',
        body: JSON.stringify({ action: 'delete_own', conversation_id: id }),
      });
      delete _state.prevMsgCache[id];
      await loadMessages(false, false);
    } catch (err) {
      console.warn('[support-widget] deleteConv error:', err);
    }
  }

  function openDeleteModal(id, triggerEl = null) {
    if (!id) return;
    _state.pendingDeleteId = id;
    _state.deleteTriggerEl = triggerEl;
    toggleGone(document.getElementById('sw-delete-modal'), false);
  }

  function closeDeleteModal() {
    const btn = document.getElementById('sw-delete-modal-confirm');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Delete conversation';
    }
    _state.pendingDeleteId = null;
    _state.deleteTriggerEl = null;
    toggleGone(document.getElementById('sw-delete-modal'), true);
  }

  async function confirmDeleteConv() {
    const id = _state.pendingDeleteId;
    const trigger = _state.deleteTriggerEl;
    const btn = document.getElementById('sw-delete-modal-confirm');
    if (!id) return closeDeleteModal();
    let triggerMarkup = null;
    if (trigger) {
      triggerMarkup = trigger.innerHTML;
      trigger.disabled = true;
      trigger.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>';
    }
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Deleting';
    }
    try {
      await deleteConv(id);
    } finally {
      if (trigger) {
        trigger.disabled = false;
        trigger.innerHTML = triggerMarkup || 'Delete';
      }
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Delete conversation';
      }
      closeDeleteModal();
    }
  }

  // ── Send message ──────────────────────────────────────────────────────
  async function sendMsg() {
    const input   = document.getElementById('sw-input');
    const sendBtn = document.getElementById('sw-send');
    const text    = (input?.value || '').trim();
    if (!text) return;

    sendBtn.disabled  = true;
    sendBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>';
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
      if (res.ok) await loadMessages(true, false);
    } catch (err) {
      console.warn('[support-widget] sendMsg error:', err);
    } finally {
      sendBtn.disabled = false;
      sendBtn.innerHTML = '<i class="fa-solid fa-paper-plane" aria-hidden="true"></i>';
      focusInput();
    }
  }

  // ── UI helpers ────────────────────────────────────────────────────────
  function updateBadge() {
    const badge = document.getElementById('sw-badge');
    if (!badge) return;
    if (_state.unread > 0 && !_state.open) {
      badge.textContent = _state.unread > 9 ? '9+' : String(_state.unread);
      badge.classList.remove('sw-gone');
    } else {
      badge.classList.add('sw-gone');
    }
  }

  function updateResolvedUI() {
    const banner   = document.getElementById('sw-res-banner');
    const inputRow = document.getElementById('sw-input-row');
    const resBtn   = document.getElementById('sw-resolve-btn');

    const resolved = _state.conversation?.resolved === true;
    const hasConv  = !!_state.conversation;

    toggleGone(banner,   !resolved);
    toggleGone(inputRow, false);
    toggleGone(resBtn,   !(hasConv && !resolved));
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
  function showToast(senderName, msgPreview) {
    const toast    = document.getElementById('sw-toast');
    const senderEl = document.getElementById('sw-toast-sender');
    const previewEl= document.getElementById('sw-toast-preview');
    const avatarEl = document.getElementById('sw-toast-avatar');
    const barEl    = document.getElementById('sw-toast-bar');
    if (!toast) return;

    // Populate content
    if (senderEl)  senderEl.textContent  = senderName || 'Support';
    if (previewEl) previewEl.textContent = msgPreview  || '';
    if (avatarEl)  avatarEl.textContent  = initials(senderName || 'Support');

    // Reset progress bar and animate
    clearTimeout(_state.toastTimer);
    if (barEl) {
      barEl.style.transition = 'none';
      barEl.style.transform  = 'scaleX(1)';
      // Double rAF so the browser registers the reset before animating
      requestAnimationFrame(() => requestAnimationFrame(() => {
        barEl.style.transition = `transform ${TOAST_MS}ms linear`;
        barEl.style.transform  = 'scaleX(0)';
      }));
    }

    // Show via class (spring animation)
    toast.classList.add('sw-toast-visible');
    _state.toastTimer = setTimeout(hideToast, TOAST_MS);
  }

  function hideToast() {
    clearTimeout(_state.toastTimer);
    const toast = document.getElementById('sw-toast');
    if (toast) toast.classList.remove('sw-toast-visible');
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
