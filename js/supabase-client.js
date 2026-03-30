// js/supabase-client.js
// Shared Supabase client for all pages.
//
// SETUP: Replace the placeholder values below with your actual Supabase
// project URL and anon (public) key. These values are safe to include in
// client-side code — they are public by design.
//
// Find them in: Supabase Dashboard → Settings → API

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// ── ⚠️  Replace these two values with your Supabase project details ──
const SUPABASE_URL      = 'https://yjqpkgcywnurlxondugo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlqcXBrZ2N5d251cmx4b25kdWdvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ4MzU4MzcsImV4cCI6MjA5MDQxMTgzN30.vOGMhiZlYrAXqfJLXNLGFVIY4UrfaFogvNS2-MyWgKw';
// ─────────────────────────────────────────────────────────────────────

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession:      true,
    autoRefreshToken:    true,
    detectSessionInUrl:  true,
  },
});
