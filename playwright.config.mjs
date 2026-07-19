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

import { BASE_URL, PORT } from './test/port.mjs';

const CHROMIUM = process.env.WEBTERM_CHROMIUM ?? '/usr/bin/chromium';
export { BASE_URL, PORT };

// The suites above run on SwiftShader, which is deterministic and needs no
// display, and that is what makes them runnable anywhere. It is also a
// different rasteriser from the one a user has: a defect that depends on real
// driver behaviour, on GPU texture sampling or on filtering does not appear
// under it. WEBTERM_GPU=1 runs the colour suites again on whatever GL the
// machine actually has, which requires a display and a working driver, so it
// is opt-in rather than part of the default run.
const GPU = process.env.WEBTERM_GPU === '1';

const gpuProjects = [1, 2].map((dpr) => ({
  name: `chromium-gpu-dpr${dpr}`,
  testMatch: /halfblock\.spec\.mjs/,
  use: {
    baseURL: BASE_URL,
    deviceScaleFactor: dpr,
    launchOptions: {
      executablePath: CHROMIUM,
      headless: false,
      args: [
        '--use-gl=angle',
        '--use-angle=gl',
        '--ignore-gpu-blocklist',
        '--enable-gpu-rasterization',
        '--disable-lcd-text',
        `--force-device-scale-factor=${dpr}`,
      ],
    },
  },
}));

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
      testMatch: /(chrome|kitty-placeholders|halfblock)\.spec\.mjs/,
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
    ...(GPU ? gpuProjects : []),
  ],
  webServer: {
    command: `node test/server.mjs`,
    url: BASE_URL,
    // Never reuse. A reused server is only the right server if it was started
    // from this same directory, and when it was not the run loads a foreign
    // build and fails on code the tree does not contain. The port is derived
    // per checkout so concurrent worktrees do not collide in the first place;
    // if one somehow does, failing to start is the loud answer and reusing is
    // the silent wrong one.
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
