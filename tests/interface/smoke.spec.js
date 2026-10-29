// Harness exemplar: proves the page's global lexical bindings are reachable
// from page.evaluate(), which every other spec file depends on.
import { test, expect } from '@playwright/test';
import { openMap, snapshot, tiles, layerRows, expectCountersReconcile } from './_map.js';

test.describe('harness', () => {
  test('the page boots and exposes its own state to the test', async ({ page }) => {
    await openMap(page);
    const s = await snapshot(page);
    expect(s.matchCount).toBeGreaterThan(0);
    expect(s.layers).toEqual({ project: true, team: true, cluster: true, commons: true, framework: true });
  });

  test('counters reconcile at the default view', async ({ page }) => {
    await openMap(page);
    await expectCountersReconcile(page, 'default view');
  });

  test('there is one tile per layer, in layer order', async ({ page }) => {
    await openMap(page);
    expect((await tiles(page)).map((t) => t.kind))
      .toEqual((await layerRows(page)).map((r) => r.kind));
  });
});
