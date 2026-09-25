import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  use: { baseURL: 'http://127.0.0.1:3199', screenshot: 'only-on-failure' },
  webServer: { command: 'PORT=3199 node e2e/fakeServer.ts', url: 'http://127.0.0.1:3199/api/meta', reuseExistingServer: false },
});
