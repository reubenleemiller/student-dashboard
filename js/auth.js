// js/auth.js
// Shared auth utilities and guards used across all pages.

import { getSupabase } from './supabase-client.js';

export const ADMIN_EMAIL = 'reuben.miller@rmtutoringservices.com';

/** Redirect to login if no active session. Returns session or null. */
export async function requireAuth(redirectTo = '/login.html') {
  const supabase = await getSupabase();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.href = redirectTo;
    return null;
  }
  return session;
}

/** Redirect to login if unauthenticated; redirect to /dashboard.html if not admin. */
export async function requireAdmin() {
  const session = await requireAuth();
  if (!session) return null;
  if (session.user.email !== ADMIN_EMAIL) {
    window.location.href = '/dashboard.html';
    return null;
  }
  return session;
}

/** Redirect already-authenticated users to their dashboard. */
export async function requireNotAuth() {
  const supabase = await getSupabase();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return;
  window.location.href = session.user.email === ADMIN_EMAIL
    ? '/admin.html'
    : '/dashboard.html';
}

/** Fetch the profile row for the given user id. */
export async function getProfile(userId) {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();
  return { data, error };
}

/** Show a toast notification. Type: 'success' | 'error' | 'info' */
export function showToast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity .3s';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

/** Simple confirmation modal helper. Returns promise<boolean>. */
export function confirmModal(message, confirmLabel = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <h3>${danger ? '⚠️ ' : ''}Are you sure?</h3>
        <p class="text-muted mt-2">${message}</p>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="modal-cancel">Cancel</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="modal-confirm">${confirmLabel}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('#modal-cancel').addEventListener('click', () => {
      overlay.remove(); resolve(false);
    });
    overlay.querySelector('#modal-confirm').addEventListener('click', () => {
      overlay.remove(); resolve(true);
    });
  });
}

/** Format a date string for display. */
export function formatDate(isoString) {
  if (!isoString) return '–';
  return new Date(isoString).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/** Format file size in human readable form. */
export function formatFileSize(bytes) {
  if (!bytes) return '–';
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
