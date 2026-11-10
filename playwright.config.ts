import { defineConfig, devices } from '@playwright/test';

/**
 * E2E runs against the production build served by the API process (run `npm run build` first).
 * If Playwright's managed browser cannot be downloaded in your environment, point PW_CHROMIUM_PATH
 * at any Chromium/Chrome binary.
 */
const customChromium = process.env.PW_CHROMIUM_PATH;
const port = Number(process.env.E2E_PORT ?? 4310);
const accessPort = port + 1;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'off',
    screenshot: 'only-on-failure',
    launchOptions: customChromium
      ? {
          executablePath: customChromium,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--use-gl=angle', '--use-angle=swiftshader', "--headless='shell'"],
        }
      : {},
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: /access\.spec\.ts/ },
    // CH-20: a second server with the visitor passcode gate on. Test-only PIN and secret; not used anywhere else.
    { name: 'access-gate', use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${accessPort}` }, testMatch: /access\.spec\.ts/ },
  ],
  webServer: [
    {
      command: `node --import tsx server/src/index.ts`,
      url: `http://127.0.0.1:${port}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { PORT: String(port), DATA_DIR: 'data/e2e-runtime', CLOCK_MODE: 'frozen', INTEGRATION_MODE: 'SIMULATED' },
    },
    {
      command: `node --import tsx server/src/index.ts`,
      url: `http://127.0.0.1:${accessPort}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(accessPort),
        DATA_DIR: 'data/e2e-access-runtime',
        CLOCK_MODE: 'frozen',
        INTEGRATION_MODE: 'SIMULATED',
        ACCESS_GATE: 'on',
        ACCESS_PIN: '4826',
        ACCESS_SESSION_SECRET: 'e2e-only-session-secret-not-used-elsewhere-0001',
        // CH-21: a made-up ID; the tests answer requests to clarity.ms themselves, nothing leaves the machine.
        CLARITY_PROJECT_ID: 'e2etest01',
        ANALYTICS_ENABLED: 'true',
      },
    },
  ],
});
