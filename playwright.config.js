// Dev-only harness. The page under test is the published artefact itself —
// served over http rather than opened from file://, because the map is embedded
// in an iframe on the site and `file://` would give it a different origin
// story than production. No build step: what is served is what is committed.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/interface',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Playwright's default — half the logical cores, so 2 on a four-core GitHub
  // runner — is left alone on purpose. Raising it to 4 was tried and was worse
  // on both counts: the suite went from 11.2 to 13.7 minutes, because four
  // Chromium instances on four vCPUs contend rather than parallelise, and the
  // clock-driven toast test started losing its race on the busier machine.
  // Sharding across runners is the way to make this faster, not oversubscribing
  // one of them.
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  // Two concurrent `playwright test` invocations in one checkout otherwise share
  // this directory and delete each other's traces mid-write, which surfaces as
  // ENOENT failures in tests that are perfectly fine. One run needs no override;
  // set PW_OUTPUT_DIR when running several at once (mutation checking, say).
  outputDir: process.env.PW_OUTPUT_DIR || 'test-results',
  use: {
    baseURL: process.env.MAP_BASE_URL || 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  // python3 -m http.server keeps the repo dependency-free on the serving side:
  // the only dev dependency in the whole tree is Playwright itself.
  webServer: {
    command: 'python3 -m http.server 4173 --bind 127.0.0.1',
    url: 'http://127.0.0.1:4173/assets/map/eu-hai-map.html',
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
