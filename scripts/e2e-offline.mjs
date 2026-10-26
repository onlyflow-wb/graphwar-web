// Headless-Chromium smoke test of the offline game: menu -> create -> add PC -> ready -> play a shot.
// usage: node scripts/e2e-offline.mjs <baseUrl> <outDir>
import { chromium } from 'playwright-core';
const [base = 'http://localhost:4173', out = '.'] = process.argv.slice(2);
const log = [];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
page.on('console', m => { if (['error', 'warning'].includes(m.type())) log.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', e => log.push(`[pageerror] ${e.message}`));
const step = async (name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { console.log('FAIL', name, '-', e.message.split('\n')[0]); await page.screenshot({ path: `${out}/fail-${name.replace(/\W+/g, '_')}.png` }); throw e; } };
const btn = t => page.locator(`img.btn[title="${t}"]`).filter({ visible: true }).first();

await page.goto(base);
await step('menu loads', async () => { await page.locator('img.btn[alt=""],img.btn').first().waitFor({ timeout: 10000 }); await page.screenshot({ path: `${out}/1-menu.png` }); });
await step('create dialog', async () => { await btn('Create a game on this device').click(); await page.locator('input.field').filter({ visible: true }).first().fill('Tester'); await page.keyboard.press('Enter'); });
await step('pregame shows', async () => { await btn('Add a computer player').waitFor(); await page.screenshot({ path: `${out}/2-pregame.png` }); });
await step('add computer player', async () => { await btn('Add a computer player').click(); const f = page.locator('input.field').filter({ visible: true }); await f.nth(0).fill('HAL'); await f.nth(1).fill('10'); await page.keyboard.press('Enter'); });
await step('switch HAL to team 2', async () => { await page.screenshot({ path: `${out}/3-roster.png` }); const sw = page.locator('img.btn[title="Switch team"]').filter({ visible: true }); const n = await sw.count(); console.log('     switch buttons:', n); if (n > 1) await sw.nth(1).click(); });
await step('ready -> countdown -> game', async () => { await btn('Ready').click(); await page.locator('canvas.plane').waitFor({ state: 'visible', timeout: 15000 }); await page.waitForTimeout(500); await page.screenshot({ path: `${out}/4-game.png` }); });
await step('fire a function', async () => {
  const f = page.locator('input.field').filter({ visible: true }).first();
  await f.waitFor(); await f.fill('x/10'); await page.screenshot({ path: `${out}/5-typed.png` });
  await btn('Fire').click(); await page.waitForTimeout(1500); await page.screenshot({ path: `${out}/6-shot.png` });
});
await page.waitForTimeout(3500);
await page.screenshot({ path: `${out}/7-after.png` });
console.log('console problems:', log.length ? '\n' + log.join('\n') : 'none');
await browser.close();
