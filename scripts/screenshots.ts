/**
 * Captures real screenshots of the running app (not mockups). Usage:
 *   SCREENSHOT_BASE=http://127.0.0.1:4300 PW_CHROMIUM_PATH=... npx tsx scripts/screenshots.ts [outDir]
 * Resets the scenario on the target server first.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const base = process.env.SCREENSHOT_BASE ?? 'http://127.0.0.1:4300';
const out = path.resolve(process.argv[2] ?? 'docs/screenshots');
fs.mkdirSync(out, { recursive: true });

const exe = process.env.PW_CHROMIUM_PATH;
const browser = await chromium.launch(exe ? { executablePath: exe, args: ['--no-sandbox', '--disable-gpu', "--headless='shell'"] } : {});
await fetch(`${base}/api/lab/reset`, { method: 'POST' });

const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
await page.goto(base);
await page.getByTestId('queue-INC-90482').click();
await page.getByRole('button', { name: 'Prepare isolation review' }).click();
await page.getByTestId('decision-code').waitFor();
await page.screenshot({ path: path.join(out, '01-decision-before-staging.png'), fullPage: true });
await page.getByTestId('stage-button').click();
await page.getByTestId('result').waitFor();
await page.screenshot({ path: path.join(out, '02-staged-and-verified.png'), fullPage: true });
await page.getByTestId('inspector').locator('summary').first().click();
await page.getByTestId('inspector').scrollIntoViewIfNeeded();
await page.screenshot({ path: path.join(out, '03-inspector-trace.png'), fullPage: true });

const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
await mobile.goto(base);
await mobile.getByTestId('queue-INC-90485').click();
await mobile.getByRole('button', { name: 'Prepare isolation review' }).click();
await mobile.getByTestId('decision-code').waitFor();
await mobile.screenshot({ path: path.join(out, '04-mobile-dark-ambiguous-identity.png'), fullPage: true });

if (process.argv.includes('--all')) {
  await page.goto(base);
  await page.getByRole('tab', { name: 'Data Studio' }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, '05-data-studio.png'), fullPage: true });
  await page.getByRole('tab', { name: 'Simulator Lab' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, '06-simulator-lab.png'), fullPage: true });
}
await browser.close();
console.info(`Screenshots written to ${out}`);
