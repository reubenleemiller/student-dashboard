// js/supabase-client.js
// Shared Supabase client for all pages.
//
// Config (SUPABASE_URL, SUPABASE_ANON_KEY) is fetched at runtime from the
// /api/public-config Netlify Function so that no secrets are stored in the repo.
//
// Set SUPABASE_URL and SUPABASE_ANON_KEY in your Netlify site's environment
// variables (Site settings → Environment variables).

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

let _supabasePromise = null;

/**
 * Returns a promise that resolves to the initialized Supabase client.
 * The client is created once and cached for subsequent calls.
 */
export function getSupabase() {
  if (_supabasePromise) return _supabasePromise;

  _supabasePromise = fetch('/api/public-config')
    .then(async (res) => {
      if (!res.ok) {
        let body = '';
        try { body = await res.text(); } catch { /* ignore */ }
        console.error(`Failed to load public config (${res.status}):`, body);
        const msg = res.status === 500
          ? 'The site is not fully configured yet. Please contact the administrator.'
          : `Failed to load site configuration (HTTP ${res.status}). Please try again later.`;
        throw Object.assign(new Error(msg), { userMessage: msg });
      }
      return res.json();
    })
    .then(({ supabaseUrl, supabaseAnonKey }) => {
      if (!supabaseUrl || !supabaseAnonKey) {
        const msg = 'Site configuration is incomplete. Please contact the administrator.';
        throw Object.assign(new Error(msg), { userMessage: msg });
      }
      return createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
          persistSession:     true,
          autoRefreshToken:   true,
          detectSessionInUrl: true,
        },
      });
    })
    .catch((err) => {
      // Show a friendly banner if we're in a browser context and the error has a userMessage
      if (err.userMessage && typeof document !== 'undefined') {
        const existing = document.getElementById('_supabase_config_error');
        if (!existing) {
          const banner = document.createElement('div');
          banner.id = '_supabase_config_error';
          banner.style.cssText =
            'position:fixed;top:0;left:0;right:0;z-index:99999;background:#7f1d1d;color:#fff;' +
            'padding:.75rem 1rem;font-size:.875rem;text-align:center;font-family:sans-serif';
          banner.textContent = err.userMessage;
          document.body.prepend(banner);
        }
      }
      throw err;
    });

  return _supabasePromise;
}
