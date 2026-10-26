// Touch-device smoke test (emulated phone, landscape, touch events only): menu -> game -> build a function with the
// on-screen keypad -> fire. Needs the DEV server (uses window.__app to see whose turn it is).
// usage: node scripts/e2e-touch.mjs <devUrl> <outDir>
import { chromium } from 'playwright-core';
const [base = 'http://localhost:5174', out = '.'] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', e => problems.push(e.message));
page.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
let failed = false;
const step = async (name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { failed = true; console.log('FAIL', name, '-', e.message.split('\n')[0]); await page.screenshot({ path: `${out}/touch-fail-${name.replace(/\W+/g, '_')}.png` }); } };
const tap = async loc => { await loc.waitFor({ timeout: 8000 }); await loc.tap({ timeout: 8000 }); };
const btn = t => page.locator(`img.btn[title="${t}"]`).filter({ visible: true }).first();
const inputs = () => page.locator('input.field').filter({ visible: true });

await page.goto(base);
await step('coarse pointer detected, stage fits the screen', async () => {
  await btn('Create a game on this device').waitFor();
  const r = await page.evaluate(() => { const b = document.getElementById('stage').getBoundingClientRect(); return { coarse: matchMedia('(pointer: coarse)').matches, w: b.width, h: b.height, vw: innerWidth, vh: innerHeight, sx: document.documentElement.scrollWidth > innerWidth }; });
  if (!r.coarse) throw new Error('pointer: coarse not matched');
  if (r.w > r.vw + 1 || r.h > r.vh + 1) throw new Error(`stage ${r.w}x${r.h} larger than viewport ${r.vw}x${r.vh}`);
  if (r.sx) throw new Error('page scrolls horizontally');
  await page.screenshot({ path: `${out}/touch-1-menu.png` });
});
await step('create game by tapping', async () => { await tap(btn('Create a game on this device')); await inputs().first().fill('Tapper'); await page.keyboard.press('Enter'); });
await step('add computer player by tapping', async () => { await tap(btn('Add a computer player')); await inputs().nth(0).fill('HAL'); await inputs().nth(1).fill('20'); await page.keyboard.press('Enter'); });
await step('ready -> game with touch bar', async () => {
  const sw = page.locator('img.btn[title="Switch team"]').filter({ visible: true });
  if (await sw.count() > 1) await sw.nth(1).tap();
  await tap(btn('Ready'));
  await page.locator('canvas.plane').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('#touchbar button').first().waitFor({ state: 'visible' });
  const bb = await page.evaluate(() => { const t = document.getElementById('touchbar').getBoundingClientRect(), s = document.getElementById('stage').getBoundingClientRect(); return { barTop: t.top, stageBottom: s.bottom, buttons: document.querySelectorAll('#touchbar button').length }; });
  if (bb.stageBottom > bb.barTop + 1) throw new Error(`touch bar overlaps the stage (${bb.stageBottom} > ${bb.barTop})`);
  if (bb.buttons < 20) throw new Error('keypad incomplete: ' + bb.buttons);
});
let mine = false;
await step('wait for my turn', async () => {
  for (let i = 0; i < 100 && !mine; i++) {
    mine = await page.evaluate(() => { const g = window.__app.session.game; const c = g.players[g.currentTurn]; return g.gameState === 2 && !!c && c.local && !c.isComputer; });
    if (!mine) await page.waitForTimeout(300);
  }
  if (!mine) throw new Error('never my turn');
  await page.waitForTimeout(400);
});
await step('keypad builds a function', async () => {
  const f = inputs().first();
  await f.fill('');
  for (const label of ['x', '÷', '2', '+', 'sin']) {
    const b = page.locator('#touchbar button', { hasText: new RegExp(`^${label.replace(/[÷+]/g, m => '\\' + m)}$`) }).first();
    if (await b.count()) await b.tap(); else await f.pressSequentially(label); // digits are not on the keypad; the soft keyboard types them
  }
  const v = await f.inputValue();
  if (v !== 'x/2+sin(') throw new Error('field is ' + JSON.stringify(v));
  await page.locator('#touchbar button', { hasText: /^⌫$/ }).tap();
  const v2 = await f.inputValue();
  if (v2 !== 'x/2+sin') throw new Error('backspace gave ' + JSON.stringify(v2));
  await f.fill('x/2'); // reset to something valid
  await page.screenshot({ path: `${out}/touch-2-game.png` });
});
await step('angle buttons respond without errors', async () => { const a = page.locator('#touchbar button.ang'); await a.nth(0).tap(); await a.nth(1).tap(); });
await step('tap Fire -> function is sent', async () => {
  await tap(btn('Fire'));
  await page.waitForFunction(() => { const g = window.__app.session.game; return g.players.some(p => !p.isComputer && p.soldiers.some(s => s.func === 'x/2')); }, null, { timeout: 5000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}/touch-3-shot.png` });
});
console.log('page errors:', problems.length ? '\n' + problems.join('\n') : 'none');
await browser.close();
process.exit(failed || problems.length ? 1 : 0);
