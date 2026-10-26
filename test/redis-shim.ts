// Test harness: a REAL redis-server plus a tiny Upstash-REST-compatible HTTP front (POST body = JSON command array,
// reply = {"result": ...}). This lets the real @upstash/redis client be tested against real TTL / NX semantics.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

function encode(cmd: unknown[]): string {
  return `*${cmd.length}\r\n` + cmd.map(a => { const s = String(a); return `$${Buffer.byteLength(s)}\r\n${s}\r\n`; }).join('');
}

/** parses one RESP reply from `buf` at `pos`; returns [value, nextPos] or null if incomplete */
function parse(buf: Buffer, pos = 0): [unknown, number] | null {
  const eol = buf.indexOf('\r\n', pos);
  if (eol < 0) return null;
  const t = String.fromCharCode(buf[pos]), line = buf.toString('utf8', pos + 1, eol), next = eol + 2;
  if (t === '+') return [line, next];
  if (t === '-') return [new Error(line), next];
  if (t === ':') return [Number(line), next];
  if (t === '$') {
    const n = Number(line);
    if (n < 0) return [null, next];
    if (buf.length < next + n + 2) return null;
    return [buf.toString('utf8', next, next + n), next + n + 2];
  }
  if (t === '*') {
    const n = Number(line); let p = next; const arr: unknown[] = [];
    for (let i = 0; i < n; i++) { const r = parse(buf, p); if (!r) return null; arr.push(r[0]); p = r[1]; }
    return [arr, p];
  }
  throw new Error('bad RESP');
}

export interface RedisHarness {
  url: string; token: string; port: number;
  /** number of commands received, by name (lower-case), for asserting "Redis was / was not touched" */
  commands: string[];
  /** make the HTTP front stop answering (simulates a hung Redis) or return 500s (an outage) */
  mode: 'ok' | 'hang' | 'down';
  raw(...cmd: unknown[]): Promise<unknown>;
  stop(): Promise<void>;
}

export async function startRedis(redisPort: number): Promise<RedisHarness> {
  const proc: ChildProcess = spawn('redis-server', ['--port', String(redisPort), '--save', '', '--appendonly', 'no', '--bind', '127.0.0.1'], { stdio: 'ignore' });
  let sock: Socket | null = null;
  for (let i = 0; i < 100 && !sock; i++) {
    sock = await new Promise<Socket | null>(res => { const s = connect(redisPort, '127.0.0.1'); s.once('connect', () => res(s)); s.once('error', () => res(null)); });
    if (!sock) await new Promise(r => setTimeout(r, 50));
  }
  if (!sock) throw new Error('redis-server did not start');
  const s = sock;
  let buf = Buffer.alloc(0);
  const waiting: Array<(v: unknown) => void> = [];
  s.on('data', d => {
    buf = Buffer.concat([buf, d]);
    for (;;) { const r = parse(buf); if (!r) break; buf = buf.subarray(r[1]); waiting.shift()?.(r[0]); }
  });
  const raw = (...cmd: unknown[]) => new Promise<unknown>((res, rej) => {
    waiting.push(v => (v instanceof Error ? rej(v) : res(v)));
    s.write(encode(cmd));
  });

  const token = 'test-token-' + Math.random().toString(36).slice(2);
  const h: RedisHarness = { url: '', token, port: redisPort, commands: [], mode: 'ok', raw, stop: async () => undefined };
  const http: Server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', async () => {
      if (h.mode === 'hang') return; // never answer
      if (h.mode === 'down') { res.statusCode = 503; res.end('{"error":"down"}'); return; }
      if (req.headers.authorization !== `Bearer ${token}`) { res.statusCode = 401; res.end('{"error":"bad token"}'); return; }
      try {
        const parsed = JSON.parse(body) as unknown[];
        res.setHeader('content-type', 'application/json');
        if ((req.url ?? '').includes('pipeline') || (req.url ?? '').includes('multi-exec')) {
          // Upstash batches same-tick commands into /pipeline: body = array of commands, reply = array of {result|error}
          const out: unknown[] = [];
          for (const cmd of parsed as unknown[][]) {
            h.commands.push(String(cmd[0]).toLowerCase());
            try { out.push({ result: await raw(...cmd) }); } catch (e) { out.push({ error: String(e) }); }
          }
          res.end(JSON.stringify(out));
          return;
        }
        h.commands.push(String(parsed[0]).toLowerCase());
        res.end(JSON.stringify({ result: await raw(...parsed) }));
      } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: String(e) })); }
    });
  });
  await new Promise<void>(r => http.listen(0, '127.0.0.1', r));
  h.url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  h.stop = async () => { http.closeAllConnections(); http.close(); s.destroy(); proc.kill('SIGKILL'); };
  return h;
}
