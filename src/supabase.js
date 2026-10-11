import { createClient } from '@supabase/supabase-js';

function normalizeUrl(url) {
  if (!url) return '';
  let clean = url.trim();
  clean = clean.replace(/\/rest\/v1\/?$/, '');
  clean = clean.replace(/\/+$/, '');
  return clean;
}

// Retrieve saved config or env variables
export function getSupabaseConfig() {
  try {
    const saved = localStorage.getItem('crm_supabase_config');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed.url && parsed.key) {
        return { url: normalizeUrl(parsed.url), key: parsed.key.trim() };
      }
    }
  } catch {}

  const envUrl = import.meta.env.VITE_SUPABASE_URL;
  const envKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (envUrl && envKey) {
    return { url: normalizeUrl(envUrl), key: envKey.trim() };
  }
  return null;
}

export function saveSupabaseConfig(cfg) {
  if (!cfg) {
    localStorage.removeItem('crm_supabase_config');
  } else {
    localStorage.setItem('crm_supabase_config', JSON.stringify(cfg));
  }
}

let supabaseInstance = null;

export function getSupabaseClient() {
  if (supabaseInstance) return supabaseInstance;
  const cfg = getSupabaseConfig();
  if (cfg && cfg.url && cfg.key) {
    try {
      supabaseInstance = createClient(cfg.url, cfg.key, {
        realtime: {
          params: {
            eventsPerSecond: 10
          }
        }
      });
      return supabaseInstance;
    } catch (e) {
      console.warn('Failed to init Supabase client:', e);
    }
  }
  return null;
}

export function resetSupabaseClient() {
  supabaseInstance = null;
}
