import { expect, test } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  const r = await request.post('/api/lab/reset');
  expect(r.ok()).toBeTruthy();
});

test('happy path: analyst stages one verified dual-approval packet without touching the device', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Check business impact before a high-risk containment' })).toBeVisible();
  await page.getByTestId('queue-INC-90482').click();
  await page.getByRole('button', { name: 'Prepare isolation review' }).click();

  await expect(page.getByTestId('headline')).toHaveText('Full isolation could interrupt SAP warehouse operations');
  await expect(page.getByTestId('decision-code')).toHaveText('REQUIRE_DUAL_APPROVAL');
  await expect(page.getByTestId('safety-state')).toHaveText('NO CONTAINMENT EXECUTED');
  await expect(page.getByText('1,420')).toBeVisible();
  await expect(page.getByTestId('constraints')).toContainText('The SAP service owner must approve any network interruption');

  await page.getByTestId('stage-button').click();
  await expect(page.getByTestId('result')).toContainText('Approval packet CAP-2026-1042 staged and verified');
  await expect(page.getByTestId('current-state')).toHaveText('WAITING_FOR_DUAL_APPROVAL');
  await expect(page.getByTestId('device-mutation')).toHaveText('None');

  // Inspector shows the real trace, including the HTTP call to the ITSM simulator.
  await page.getByTestId('inspector').locator('summary').first().click();
  await expect(page.getByTestId('inspector')).toContainText('tool.stageContainmentApproval');
  await expect(page.getByTestId('inspector')).toContainText('POST mock-itsm/api/approval-packets');

  // Domain state, not just the UI: the packet exists in the simulator and the device is untouched.
  const view = await (await request.get('/api/queue')).json();
  const item = view.value.find((q: { incidentId: string }) => q.incidentId === 'INC-90482');
  expect(item.latestRequest.state).toBe('WAITING_FOR_DUAL_APPROVAL');
  expect(item.isolationState).toBe('NOT_ISOLATED');
});

test('negative path: stale CMDB evidence blocks staging and explains why', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('queue-INC-90483').click();
  await page.getByRole('button', { name: 'Prepare isolation review' }).click();
  await expect(page.getByTestId('decision-code')).toHaveText('INSUFFICIENT_EVIDENCE');
  await expect(page.getByTestId('verdict')).toContainText('The CMDB record is older than the allowed maximum');
  await expect(page.getByTestId('stage-button')).toHaveCount(0);
  await expect(page.getByText('No approval packet')).toBeVisible();
});

test('device history line shows no prior history for the seeded scenario', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('queue-INC-90482').click();
  await page.getByRole('button', { name: 'Prepare isolation review' }).click();
  await expect(page.getByTestId('device-history')).toHaveText('History for this device (last 90 days, this request not counted): no prior history.');
});

test('evidence-age bars: current records are within limits, a stale record says by how much', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('queue-INC-90482').click();
  await page.getByRole('button', { name: 'Prepare isolation review' }).click();
  await expect(page.getByTestId('age-bars')).toContainText('17 min old, within the 60 min limit');
  await expect(page.getByTestId('age-bars')).toContainText('2 min old, within the 15 min limit');
  await page.getByTestId('queue-INC-90483').click();
  await page.getByRole('button', { name: 'Prepare isolation review' }).click();
  await expect(page.getByTestId('age-bars')).toContainText('9.2 h old, over the 60 min limit by 8.2 h');
  await expect(page.getByRole('img', { name: /CMDB record: 9.2 h old/ })).toBeVisible();
});

test('activity history: latest event first, full history behind a keyboard-operable disclosure', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('queue-INC-90482').click();
  await page.getByRole('button', { name: 'Prepare isolation review' }).click();
  await page.getByTestId('stage-button').click();
  await expect(page.getByTestId('activity-latest')).toContainText('Approval packet CAP-2026-1042 created and read back');
  const summary = page.getByTestId('activity').locator('summary');
  await expect(summary).toHaveText('View history (3)');
  await expect(page.getByTestId('activity-all')).toBeHidden();
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('activity-all')).toContainText('analyst-priya asked to fully isolate the device');
});

test('source badges: Defender and CMDB values are shown side by side, not merged', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('queue-INC-90486').click();
  await page.getByRole('button', { name: 'Prepare isolation review' }).click();
  await expect(page.getByTestId('badge-defender')).toHaveText('Defender criticality: Standard');
  await expect(page.getByTestId('badge-cmdb')).toHaveText('CMDB tier: Tier 1');
});

test('blocked action offers a demo switch to an eligible role, then the action works', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Acting as').selectOption('owner-sap-ewm');
  await page.getByTestId('queue-INC-90482').click();
  await page.getByRole('button', { name: 'Prepare isolation review' }).click();
  await expect(page.getByRole('alert')).toContainText('ROLE_NOT_PERMITTED');
  await page.getByTestId('demo-switch').getByRole('button', { name: 'Demo: switch to Priya Natarajan (SOC analyst)' }).click();
  await expect(page.getByLabel('Acting as')).toHaveValue('analyst-priya');
  await expect(page.getByTestId('demo-switch')).toHaveCount(0);
  await page.getByRole('button', { name: 'Prepare isolation review' }).click();
  await expect(page.getByTestId('decision-code')).toHaveText('REQUIRE_DUAL_APPROVAL');
});

test('lifecycle stepper marks the current step for a waiting request, and a blocked one honestly', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('queue-INC-90482').click();
  await page.getByRole('button', { name: 'Prepare isolation review' }).click();
  await page.getByTestId('stage-button').click();
  await expect(page.getByTestId('stepper').locator('[aria-current="step"]')).toContainText('Waiting for two approvals');
  await page.getByTestId('queue-INC-90483').click();
  await page.getByRole('button', { name: 'Prepare isolation review' }).click();
  await expect(page.getByTestId('stepper')).toContainText('Blocked: not enough current evidence');
  await expect(page.getByTestId('stepper').locator('[aria-current="step"]')).toHaveCount(0);
});

test('policy provenance: version used, ordered rules, and an honest note about missing author and date', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('queue-INC-90482').click();
  await page.getByRole('button', { name: 'Prepare isolation review' }).click();
  const prov = page.getByTestId('policy-provenance');
  await prov.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(prov).toContainText('This decision used policy CAP-1.1.');
  await expect(prov).toContainText('It has 5 ordered rules');
  await expect(prov).toContainText('Provenance unavailable');
});

test('audit check: the Inspector re-checks the whole Gate audit log and reports the verified range', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('queue-INC-90482').click();
  await page.getByRole('button', { name: 'Prepare isolation review' }).click();
  await page.getByTestId('inspector').locator('summary').first().click();
  await page.getByRole('tab', { name: /Audit/ }).click();
  await page.getByTestId('audit-verify').click();
  await expect(page.getByTestId('audit-verify-result')).toContainText(/Audit log check passed for entries 1 to \d+/);
  await expect(page.getByTestId('audit-verify-result')).toContainText('local tamper evidence only');
});

test('evidence export: downloads the package and shows its status in words', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('queue-INC-90482').click();
  await page.getByRole('button', { name: 'Prepare isolation review' }).click();
  await page.getByTestId('stage-button').click();
  await expect(page.getByTestId('current-state')).toHaveText('WAITING_FOR_DUAL_APPROVAL');
  const download = page.waitForEvent('download');
  await page.getByTestId('export-evidence').click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^audit-evidence-REQ-[A-Z0-9]+\.json$/);
  await expect(page.getByTestId('export-status')).toHaveText('complete');
  await expect(page.getByTestId('export-result')).toContainText('Checksum (SHA-256):');
});

test('evidence export: a service owner not named on the request is refused', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('queue-INC-90482').click();
  await page.getByRole('button', { name: 'Prepare isolation review' }).click();
  await page.getByLabel('Acting as').selectOption('owner-payments');
  await page.getByTestId('export-evidence').click();
  await expect(page.getByTestId('export-error')).toContainText('EXPORT_NOT_PERMITTED');
});

test('evidence checks: counts near the decision, and a stale record shows blocked and not-evaluated checks honestly', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('queue-INC-90482').click();
  await page.getByRole('button', { name: 'Prepare isolation review' }).click();
  await expect(page.getByTestId('evidence-checks-summary')).toHaveText('8 passed, 1 warned, 0 blocked, 0 not evaluated');
  await page.getByTestId('queue-INC-90483').click();
  await page.getByRole('button', { name: 'Prepare isolation review' }).click();
  const box = page.getByTestId('evidence-checks');
  await box.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('check-EVIDENCE_FRESH')).toContainText('Blocked');
  await expect(page.getByTestId('check-BUSINESS_IMPACT')).toContainText('Not evaluated');
  await expect(box).toContainText('They are not model reasoning.');
});
