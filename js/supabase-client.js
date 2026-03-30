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
    .then((res) => {
      if (!res.ok) throw new Error(`Failed to load public config (${res.status})`);
      return res.json();
    })
    .then(({ supabaseUrl, supabaseAnonKey }) => {
      return createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
          persistSession:     true,
          autoRefreshToken:   true,
          detectSessionInUrl: true,
        },
      });
    });

  return _supabasePromise;
}
