/** Product-clarity: browser checks for the new first-run path, decision-first layout, counts and present mode. */
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  expect((await request.post('/api/lab/reset')).ok()).toBeTruthy();
});

test('first visit: one press shows the decision, the reasons and the single next action without scrolling (1280x800)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(page.getByTestId('first-run')).toContainText('What it never does.');
  await page.getByTestId('show-example').click();
  await expect(page.getByTestId('decision-code')).toHaveText('REQUIRE_DUAL_APPROVAL');
  await expect(page.getByTestId('verdict')).toContainText('A change freeze is active');
  await expect(page.getByTestId('stage-button')).toBeInViewport();
  await expect(page.getByTestId('safety-state')).toBeInViewport();
  await expect(page.getByTestId('cta-note')).toContainText('No device is changed.');
  await expect(page.getByTestId('current-state')).toHaveText('RESPONSE_READY');
});

test('queue groups by what it needs: a checked item moves out of "Not checked yet"', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('queue-group-new')).toContainText('Not checked yet');
  await page.getByTestId('queue-INC-90483').click();
  await page.getByRole('button', { name: 'Prepare isolation review' }).click();
  await expect(page.getByTestId('queue-group-action')).toContainText('PRD-MES-APP01');
  await expect(page.getByTestId('queue-group-new')).not.toContainText('PRD-MES-APP01');
});

test('live counts: the Gate executed no containment, and approvals waiting are counted on the tab', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('metrics-strip')).toHaveCount(0); // a first visit stays calm
  await page.getByTestId('queue-INC-90482').click();
  await page.getByRole('button', { name: 'Prepare isolation review' }).click();
  await page.getByTestId('stage-button').click();
  await expect(page.getByTestId('result')).toBeVisible();
  await expect(page.getByTestId('metric-gate-executed')).toContainText('0');
  await expect(page.getByTestId('metric-sent')).toContainText('1');
  await page.getByLabel('Acting as').selectOption('soc-incident-commander');
  await expect(page.getByTestId('approvals-waiting')).toContainText('1');
  await page.getByRole('tab', { name: /Approvals/ }).click();
  await expect(page.getByTestId('packet-CAP-2026-1042')).toContainText('Approve full isolation of PRD-SAP-GW02?');
  await expect(page.getByTestId('packet-CAP-2026-1042')).toContainText('A change freeze is active');
  await page.getByTestId('approve-CAP-2026-1042').click();
  await expect(page.getByTestId('approvals-waiting')).toHaveCount(0);
});

test('present mode hides the Simulator Lab and pins the counts; turning it off restores both', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('present-toggle').click();
  await expect(page.getByRole('tab', { name: /Simulator Lab/ })).toHaveCount(0);
  await expect(page.getByTestId('metrics-strip')).toBeVisible();
  await page.getByTestId('present-toggle').click();
  await expect(page.getByRole('tab', { name: /Simulator Lab/ })).toBeVisible();
});

test('Lab: failure drills stay one click away; clock and concurrency sit behind Advanced', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Simulator Lab' }).click();
  await expect(page.getByTestId('lab-frame')).toContainText('not part of the Gate');
  await expect(page.getByTestId('advance-16')).toBeHidden();
  await page.getByTestId('lab-advanced').locator('summary').click();
  await expect(page.getByTestId('advance-16')).toBeVisible();
  await expect(page.getByTestId('concurrent-update')).toBeVisible();
});
