'use strict';

// Supabase client singleton.
// dotenv is loaded by index.js at startup, so env vars are available here.

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing Supabase credentials. Set SUPABASE_URL and SUPABASE_ANON_KEY in your .env file.'
  );
}

// Create and export a single shared client instance.
const supabase = createClient(supabaseUrl, supabaseAnonKey);

module.exports = supabase;
