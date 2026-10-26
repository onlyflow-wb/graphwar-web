// Measures how much the computer player blocks the page's main thread (headless Chromium, software rendering, so
// absolute numbers are only comparable between runs on the same machine).
// usage: node scripts/bench-ai-browser.mjs <baseUrl> <aiLevel> [label]
// Starts an offline game vs one computer player, fires once so the AI gets a turn, and records main-thread stalls
// (setInterval(4ms) gaps + Long Tasks API) from the human's shot until the AI has fired (or 40 s).
import { chromium } from 'playwright-core';
const [base = 'http://localhost:4173', level = '100', label = 'run'] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
const btn = t => page.locator(`img.btn[title="${t}"]`).filter({ visible: true }).first();
await page.goto(base);
await btn('Create a game on this device').click();
await page.locator('input.field').filter({ visible: true }).first().fill('Tester'); await page.keyboard.press('Enter');
await btn('Add a computer player').click();
const f = page.locator('input.field').filter({ visible: true });
await f.nth(0).fill('HAL'); await f.nth(1).fill(level); await page.keyboard.press('Enter');
const sw = page.locator('img.btn[title="Switch team"]').filter({ visible: true });
if (await sw.count() > 1) await sw.nth(1).click();
await btn('Ready').click();
await page.locator('canvas.plane').waitFor({ state: 'visible', timeout: 15000 });
await page.waitForTimeout(500);
await page.evaluate(() => {
  const w = window; w.__gaps = []; w.__long = []; let last = performance.now();
  w.__t = setInterval(() => { const n = performance.now(); w.__gaps.push(n - last); last = n; }, 4);
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) w.__long.push(e.duration); }).observe({ entryTypes: ['longtask'] }); } catch {}
});
// the human shoots whenever it is their turn (who starts is random); the AI plays its turns. Needs the dev server
// (window.__app) to know whose turn it is and when the AI has fired.
const t0 = Date.now();
let aiFiredAfter = null, humanShots = 0;
while (Date.now() - t0 < 25000) {
  await page.waitForTimeout(250);
  const st = await page.evaluate(() => { const g = window.__app?.session?.game; if (!g || g.gameState !== 2) return null; const cur = g.players[g.currentTurn]; return { human: !!cur && cur.local && !cur.isComputer, aiFired: g.players.some(p => p.isComputer && p.soldiers.some(s => s.func)) }; });
  if (!st) continue;
  if (st.aiFired && aiFiredAfter === null) aiFiredAfter = (Date.now() - t0) / 1000;
  if (st.human) {
    try { const i = page.locator('input.field').filter({ visible: true }).first(); await i.fill('x/10', { timeout: 2000 }); await btn('Fire').click({ timeout: 2000 }); humanShots++; } catch {}
  }
}
const r = await page.evaluate(() => {
  clearInterval(window.__t);
  const g = [...window.__gaps].sort((a, b) => a - b), q = p => g[Math.min(g.length - 1, Math.floor(p * g.length))];
  const lt = window.__long;
  return { samples: g.length, gap_p50: q(.5), gap_p99: q(.99), gap_max: g[g.length - 1],
           longtasks: lt.length, longtask_total_ms: lt.reduce((a, b) => a + b, 0), longtask_max_ms: Math.max(0, ...lt) };
});
console.log(JSON.stringify({ label, level: Number(level), seconds: (Date.now() - t0) / 1000, ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v * 10) / 10])), aiFiredAfterS: aiFiredAfter, humanShots, workers: page.workers().length, pageErrors: errs.length }));
if (process.env.DEBUG_STATE) console.log(JSON.stringify(await page.evaluate(() => { const g = window.__app?.session?.game; return g && { state: g.gameState, turn: g.currentTurn, players: g.players.map(p => ({ n: p.name, comp: p.isComputer, funcs: p.soldiers.map(s => s.func) })) }; })));
await browser.close();
