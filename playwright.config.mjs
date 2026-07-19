// Browser tests for webterm.
//
// The browser is the system chromium, pinned by executablePath so no Playwright
// browser download lands in the cache. Headless GL here is ANGLE over
// SwiftShader, so these suites assert what is on the canvas and how the grid is
// laid out, never a frame rate or an absolute timing.
//
// The only process the run starts is a static file server for the fixtures,
// which Playwright owns and tears down.
import { defineConfig } from '@playwright/test';

const CHROMIUM = process.env.WEBTERM_CHROMIUM ?? '/usr/bin/chromium';
export const PORT = process.env.WEBTERM_TEST_PORT ?? '7811';
export const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './test/browser',
  testMatch: /.*\.spec\.mjs/,
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  projects: [
    {
      name: 'chromium',
      use: {
        baseURL: BASE_URL,
        launchOptions: {
          executablePath: CHROMIUM,
          args: [
            '--use-gl=angle',
            '--use-angle=swiftshader',
            '--enable-unsafe-swiftshader',
            '--disable-lcd-text',
            '--force-device-scale-factor=1',
          ],
        },
        permissions: ['clipboard-read', 'clipboard-write'],
      },
    },
    {
      // The chrome and placeholder suites again at a doubled device pixel
      // ratio. Both are correct only if edges land where the cell grid puts
      // them, and a fractional cell box rounds differently at each ratio, so
      // they are checked at both.
      name: 'chromium-dpr2',
      testMatch: /(chrome|kitty-placeholders)\.spec\.mjs/,
      use: {
        baseURL: BASE_URL,
        deviceScaleFactor: 2,
        launchOptions: {
          executablePath: CHROMIUM,
          args: [
            '--use-gl=angle',
            '--use-angle=swiftshader',
            '--enable-unsafe-swiftshader',
            '--disable-lcd-text',
            '--force-device-scale-factor=2',
          ],
        },
      },
    },
  ],
  webServer: {
    command: `node test/server.mjs`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
