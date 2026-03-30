// netlify/functions/public-config.js
// Returns public Supabase config to the browser at runtime.
// Environment variables required:
//   SUPABASE_URL       – Supabase project URL
//   SUPABASE_ANON_KEY  – Supabase anon (public) key

exports.handler = async () => {
  const supabaseUrl     = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return {
      statusCode: 500,
      headers: {
        'Content-Type':  'application/json',
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify({ error: 'Server configuration error' }),
    };
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type':  'application/json',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify({ supabaseUrl, supabaseAnonKey }),
  };
};
