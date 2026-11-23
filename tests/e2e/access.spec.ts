import { expect, test } from '@playwright/test';

test('passcode page: wrong PIN is refused with a plain message, the right one opens the app at the same address', async ({ page }) => {
  const appRequests: string[] = [];
  page.on('request', (r) => {
    if (!r.url().includes('/api/access/')) appRequests.push(r.url());
  });
  await page.goto('/approvals');
  await expect(page.getByRole('heading', { name: 'Business Impact Gate' })).toBeVisible();
  // Only the gate document itself was loaded: no app bundle, no API calls, nothing third-party.
  expect(appRequests.filter((u) => !u.endsWith('/approvals'))).toEqual([]);
  const pin = page.getByLabel('Passcode');
  await expect(pin).toBeFocused();
  await pin.fill('1111');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toHaveText('That passcode did not work. Try again.');
  await expect(pin).toHaveValue('');
  await pin.fill('4826');
  await page.getByRole('button', { name: 'Enter Business Impact Gate' }).click();
  // The app has no path routes; any path serves the app shell, and the address the visitor asked for is kept.
  const home = page.getByRole('heading', { name: 'Check business impact before a high-risk containment' });
  await expect(home).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/approvals');
  // Refresh keeps the session.
  await page.reload();
  await expect(home).toBeVisible();
  // Leaving ends the session and shows the passcode page again.
  await page.getByTestId('leave-demo').click();
  await expect(page.getByLabel('Passcode')).toBeVisible();
  expect((await page.request.get('/api/queue')).status()).toBe(401);
});

test('passcode page works at phone width and accepts a pasted code', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  await page.goto('/');
  const box = await page.locator('form').boundingBox();
  expect(box!.width).toBeLessThanOrEqual(375 - 32);
  await page.getByLabel('Passcode').focus();
  await page.evaluate(() => {
    const i = document.getElementById('pin') as HTMLInputElement;
    i.value = '4 8-2 6';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.getByLabel('Passcode')).toHaveValue('4826');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Check business impact before a high-risk containment' })).toBeVisible();
});

// CH-21: requests to clarity.ms are answered locally by the test, so nothing leaves the machine.
async function watchClarity(page: import('@playwright/test').Page) {
  const hits: string[] = [];
  await page.route('https://www.clarity.ms/**', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: '/* test stub */' }));
  page.on('request', (r) => {
    if (r.url().includes('clarity')) hits.push(r.url());
  });
  return hits;
}

test('analytics: nothing on the passcode page or after a wrong PIN, nothing before consent, one tag after Allow', async ({ page }) => {
  const hits = await watchClarity(page);
  await page.goto('/');
  await page.getByLabel('Passcode').fill('0000');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toContainText('did not work');
  expect(hits).toEqual([]);
  await page.getByLabel('Passcode').fill('4826');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('analytics-notice')).toBeVisible();
  // This server keeps its data between runs; start the scenario from its seeded state (the session cookie is shared).
  expect((await page.request.post('/api/lab/reset')).ok()).toBeTruthy();
  await page.reload();
  await expect(page.getByTestId('analytics-notice')).toBeVisible();
  expect(hits).toEqual([]);
  await expect(page.locator('main[data-clarity-mask="true"]')).toHaveCount(1);
  await expect(page.getByLabel('Acting as')).toHaveAttribute('data-clarity-mask', 'true');

  await page.getByRole('button', { name: 'Allow' }).click();
  await expect(page.getByTestId('analytics-status')).toContainText('Usage analytics is on.');
  await expect.poll(() => hits.length).toBe(1);
  expect(hits[0]).toBe('https://www.clarity.ms/tag/e2etest01');

  // Using the app sends only approved event names; switching tabs does not add a second tag.
  await page.getByTestId('queue-INC-90482').click();
  await page.getByRole('button', { name: 'Prepare isolation review' }).click();
  await page.getByRole('tab', { name: /Approvals/ }).click();
  await page.getByRole('tab', { name: /Review/ }).click();
  const calls = await page.evaluate(() => ((window as unknown as { clarity: { q: unknown[][] } }).clarity.q ?? []).map((c) => JSON.stringify(c)));
  expect(calls).toEqual([
    JSON.stringify(['consentv2', { ad_Storage: 'denied', analytics_Storage: 'granted' }]),
    JSON.stringify(['event', 'project_entered']),
    // e907954 tags the session with the synthetic demo user ID. Exactly once per consent; never a name, record ID or free text.
    JSON.stringify(['identify', 'analyst-priya']),
    JSON.stringify(['event', 'record_opened']),
    JSON.stringify(['event', 'scenario_started']),
  ]);
  expect(hits).toHaveLength(1);
  await expect(page.locator('script[data-analytics="clarity"]')).toHaveCount(1);

  // A reload installs it once for the new page, never twice.
  await page.reload();
  await expect.poll(() => hits.length).toBe(2);
  await expect(page.locator('script[data-analytics="clarity"]')).toHaveCount(1);

  // Turning it off removes it from the next page.
  await page.getByRole('button', { name: 'Turn it off' }).click();
  await expect(page.getByTestId('analytics-status')).toContainText('Usage analytics is off.');
  await expect(page.locator('script[data-analytics="clarity"]')).toHaveCount(0);
  expect(hits).toHaveLength(2);
});

test('analytics: "No thanks" loads nothing, also after a reload', async ({ page }) => {
  const hits = await watchClarity(page);
  await page.goto('/');
  await page.getByLabel('Passcode').fill('4826');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'No thanks' }).click();
  await page.reload();
  await expect(page.getByTestId('analytics-status')).toContainText('Usage analytics is off.');
  expect(hits).toEqual([]);
});
