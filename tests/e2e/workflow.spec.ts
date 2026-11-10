import { expect, test } from '@playwright/test';
import path from 'node:path';

test.beforeEach(async ({ request }) => {
  expect((await request.post('/api/lab/reset')).ok()).toBeTruthy();
});

test('Excel import fixes a stale CMDB record and changes the next Gate decision', async ({ page }) => {
  await page.goto('/');
  // Before: the MES server is blocked for stale evidence.
  await page.getByTestId('queue-INC-90483').click();
  await page.getByRole('button', { name: 'Prepare isolation review' }).click();
  await expect(page.getByTestId('decision-code')).toHaveText('INSUFFICIENT_EVIDENCE');

  await page.getByRole('tab', { name: 'Data Studio' }).click();
  await page.getByTestId('import-file').setInputFiles(path.resolve('fixtures/imports/files/valid-fix-stale-mes-cmdb.xlsx'));
  await page.getByTestId('preview-import').click();
  await expect(page.getByTestId('import-preview')).toContainText('CI-007120 (updated: lastVerifiedAt)');
  await expect(page.getByTestId('commit-import')).toBeDisabled();
  await page.getByTestId('confirm-import').check();
  await page.getByTestId('commit-import').click();
  await expect(page.getByTestId('import-committed')).toContainText('1 row(s) re-read from the simulators and verified');

  await page.getByRole('tab', { name: 'Review' }).click();
  await page.getByTestId('queue-INC-90483').click();
  await page.getByTestId('reevaluate-button').click();
  await expect(page.getByTestId('decision-code')).toHaveText('REQUIRE_DUAL_APPROVAL');
});

test('invalid workbook shows located errors and offers no commit', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Data Studio' }).click();
  await page.getByTestId('import-file').setInputFiles(path.resolve('fixtures/imports/files/invalid-orphan-reference.xlsx'));
  await page.getByTestId('preview-import').click();
  await expect(page.getByTestId('import-issues')).toContainText('ORPHAN_REFERENCE');
  await expect(page.getByTestId('import-issues')).toContainText('INC-00000');
  await expect(page.getByTestId('commit-import')).toHaveCount(0);
});

test('two approvers approve in the inbox; approval does not execute containment', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('queue-INC-90482').click();
  await page.getByRole('button', { name: 'Prepare isolation review' }).click();
  await page.getByTestId('stage-button').click();
  await expect(page.getByTestId('result')).toBeVisible();

  const identity = page.getByLabel('Acting as');
  await identity.selectOption('soc-incident-commander');
  await page.getByRole('tab', { name: 'Approvals' }).click();
  // CH-7: the approver sees the projected effect before deciding.
  await expect(page.getByTestId('impact-CAP-2026-1042')).toContainText('1,420 active at 06:12 UTC');
  await expect(page.getByTestId('impact-CAP-2026-1042')).toContainText('Projection only');
  await page.getByTestId('approve-CAP-2026-1042').click();
  await expect(page.getByTestId('packet-CAP-2026-1042')).toContainText('Partially approved');

  await identity.selectOption('owner-sap-ewm');
  await page.getByTestId('approve-CAP-2026-1042').click();
  await expect(page.getByTestId('packet-CAP-2026-1042')).toContainText('Approved');
  await expect(page.getByTestId('packet-CAP-2026-1042')).toContainText('You recorded an approval');

  await identity.selectOption('analyst-priya');
  await page.getByRole('tab', { name: 'Review' }).click();
  await expect(page.getByTestId('current-state')).toHaveText('APPROVED_FOR_MANUAL_EXECUTION');
  await expect(page.getByTestId('safety-state')).toHaveText('NO CONTAINMENT EXECUTED');
});

test('failure path: corrupted read-back is escalated, not reported as success', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('queue-INC-90482').click();
  await page.getByRole('button', { name: 'Prepare isolation review' }).click();
  await page.getByRole('tab', { name: 'Simulator Lab' }).click();
  await page.getByRole('button', { name: 'Inject' }).nth(3).click(); // corrupt next read-back
  await page.getByRole('tab', { name: 'Review' }).click();
  await page.getByTestId('stage-button').click();
  await expect(page.getByTestId('result-failed')).toContainText('not treated as staged');
  await expect(page.getByTestId('last-error')).toContainText('READBACK_MISMATCH');
});

test('keyboard-only: select a queue item and prepare a review', async ({ page }) => {
  await page.goto('/');
  const item = page.getByTestId('queue-INC-90484');
  await item.focus();
  await page.keyboard.press('Enter');
  const prepare = page.getByRole('button', { name: 'Prepare isolation review' });
  await prepare.focus();
  await expect(prepare).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('decision-code')).toHaveText('STANDARD_RESPONSE_ELIGIBLE');
});

test('mobile width: no horizontal page scroll on the decision page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByTestId('queue-INC-90482').click();
  await page.getByRole('button', { name: 'Prepare isolation review' }).click();
  await expect(page.getByTestId('decision-code')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('optional scenario: a second incident on the same device shows a possible-duplicate warning', async ({ page, request }) => {
  expect((await request.post('/api/lab/scenarios/possible-duplicate')).ok()).toBeTruthy();
  await page.goto('/');
  await page.getByTestId('queue-INC-90482').click();
  await page.getByRole('button', { name: 'Prepare isolation review' }).click();
  await page.getByTestId('stage-button').click();
  await expect(page.getByTestId('result')).toBeVisible();

  await page.getByTestId('queue-INC-90488').click();
  await page.getByRole('button', { name: 'Prepare isolation review' }).click();
  await expect(page.getByTestId('possible-duplicate')).toContainText('INC-90482 already has a request for this device');
  await expect(page.getByTestId('possible-duplicate')).toContainText('can be legitimate');
  await expect(page.getByTestId('decision-code')).toHaveText('REQUIRE_DUAL_APPROVAL');
});

test('bulk approval: two packets approved in one action, each recorded on its own', async ({ page, request }) => {
  await page.goto('/');
  for (const id of ['INC-90482', 'INC-90486']) {
    await page.getByTestId(`queue-${id}`).click();
    await page.getByRole('button', { name: 'Prepare isolation review' }).click();
    await page.getByTestId('stage-button').click();
    await expect(page.getByTestId('result')).toBeVisible();
  }
  await page.getByLabel('Acting as').selectOption('soc-incident-commander');
  await page.getByRole('tab', { name: 'Approvals' }).click();
  await page.getByTestId('select-CAP-2026-1042').check();
  await page.getByTestId('select-CAP-2026-1043').check();
  await page.getByTestId('bulk-approve').click();
  await page.getByTestId('bulk-confirm').click();
  await expect(page.getByTestId('bulk-result')).toContainText('2 of 2 approved');
  await expect(page.getByTestId('packet-CAP-2026-1042')).toContainText('Partially approved');
  await expect(page.getByTestId('packet-CAP-2026-1043')).toContainText('Partially approved');
  const audit = await (await request.get('/api/audit')).json();
  expect(audit.value.filter((e: { action: string }) => e.action === 'APPROVER_APPROVE')).toHaveLength(2);
});

test('empty states say which kind of empty they are', async ({ page, request }) => {
  // Approvals: nothing assigned yet.
  await page.goto('/');
  await page.getByLabel('Acting as').selectOption('owner-mes');
  await page.getByRole('tab', { name: 'Approvals' }).click();
  await expect(page.getByTestId('approvals-empty')).toContainText('Nothing is assigned to you yet');

  // Approvals: everything assigned is already closed.
  await page.getByLabel('Acting as').selectOption('analyst-priya');
  await page.getByRole('tab', { name: 'Review' }).click();
  await page.getByTestId('queue-INC-90482').click();
  await page.getByRole('button', { name: 'Prepare isolation review' }).click();
  await page.getByTestId('stage-button').click();
  await expect(page.getByTestId('result')).toBeVisible();
  const r = await request.post('/api/approvals/CAP-2026-1042/decision', { headers: { 'x-demo-user': 'owner-sap-ewm' }, data: { decision: 'REJECT', comment: '' } });
  expect(r.ok()).toBeTruthy();
  await page.getByLabel('Acting as').selectOption('owner-sap-ewm');
  await page.getByRole('tab', { name: 'Approvals' }).click();
  await expect(page.getByTestId('approvals-empty')).toContainText('Your only packet is decided or closed. Nothing is waiting for you.');

  // Data Studio: a search with no matches offers a way back.
  await page.getByRole('tab', { name: 'Data Studio' }).click();
  await page.getByRole('searchbox', { name: 'Search records' }).fill('no-such-thing-zz');
  await expect(page.getByTestId('records-empty')).toContainText('No records match "no-such-thing-zz"');
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(page.getByTestId('records-empty')).toHaveCount(0);
});

test('empty queue says there are no active incidents (queue response stubbed empty)', async ({ page }) => {
  await page.route('**/api/queue', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"value":[]}' }));
  await page.goto('/');
  await expect(page.getByTestId('queue-empty')).toHaveText('No active incidents right now. When an incident with a device is active, it appears here.');
});
