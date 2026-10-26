import type { VercelRequest, VercelResponse } from '@vercel/node';
import { roomsHandler } from './_lib/handlers.js';
import { runtime } from './_lib/runtime.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let rt;
  try { rt = runtime(); } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    res.status(500).json({ error: 'not_configured' });
    return;
  }
  const out = await roomsHandler(req, rt);
  for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
  res.status(out.status).send(JSON.stringify(out.body));
}
