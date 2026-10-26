import type { VercelRequest, VercelResponse } from '@vercel/node';
import { cleanupHandler } from '../_lib/handlers.js';
import { runtime } from '../_lib/runtime.js';

// Called by Vercel Cron (vercel.json); Vercel sends "Authorization: Bearer $CRON_SECRET" automatically.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  let rt;
  try { rt = runtime(); } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    res.status(500).json({ error: 'not_configured' });
    return;
  }
  const out = await cleanupHandler(req, rt);
  for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
  res.status(out.status).send(JSON.stringify(out.body));
}
