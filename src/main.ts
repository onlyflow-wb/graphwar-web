import './ui/style.css';
import { App } from './ui/app';
import type { LobbyClient } from './net/types';

// Online play needs a Supabase project (see README / .env.example). Without these variables the game runs offline.
// Only the public anon key is ever used in the browser; row-level security does the access control.
async function connectOnline(): Promise<LobbyClient | null> {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  const [{ createClient }, { createOnline }] = await Promise.all([import('@supabase/supabase-js'), import('./net/online')]);
  return createOnline(createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true },
    realtime: { params: { eventsPerSecond: 40 } },
  }), { roomsApi: '/api/rooms' });
}

const app = new App(await connectOnline());
if (import.meta.env.DEV) (window as unknown as { __app: App }).__app = app; // test hook, stripped from production builds
app.start().catch(err => {
  console.error(err);
  const s = document.getElementById('stage');
  if (s) s.textContent = 'Could not start Graphwar: ' + (err instanceof Error ? err.message : String(err));
});
