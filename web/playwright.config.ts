import { defineConfig, devices } from '@playwright/test';

const PORT = 3107;

// Runs on sample data, so it needs no desk, Worker or wallet. CHROMIUM_PATH points at a local Chromium if
// Playwright's own build isn't installed.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  projects: [
    { name: 'phone', use: { ...devices['Pixel 7'], defaultBrowserType: 'chromium' } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    command: `next dev -p ${PORT}`,
    url: `http://localhost:${PORT}/how`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { DATA_SOURCE: 'fixtures', NEAR_NETWORK: 'mainnet' },
  },
});
