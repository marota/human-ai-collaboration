// Chat column — spec §18, invariants 10 and 16.
//
// Two halves. The first is the opt-in, and it is the one that protects every
// other reader: without `?chat=1` there must be no pill, no panel, no host
// object, and above all no request for hai-chat.js. invariant 10 is asserted
// over the whole surface in integrity.spec.js; this file asserts the gate
// itself, from both sides.
//
// The second is the column, driven against a stubbed server. The point is not
// to test the model — nothing here runs one — but the contract between the
// page and chat/server.py: which events the stream carries, that a link only
// survives when its id is a real card, that the generated form reads the field
// table the server sent, and that what the contributor edited is what ends up
// in the issue. A model in the loop would make none of that assertable.
import { test, expect } from '@playwright/test';
import { openMap, MAP_PATH } from './_map.js';

// openMap() appends `hash` straight after `?lang=`, so the opt-in rides there.
const CHAT = { hash: '&chat=1' };

const HEALTH = {
  ok: true,
  data: { as_of: '2026-09-03', counts: { project: 111, team: 268, commons: 25, framework: 45, links: 299 }, source: 'assets/map/hai-data.js' },
  model: { url: 'http://127.0.0.1:11434', chat_model: 'test-model', draft_model: 'test-drafter', reachable: true, models: ['test-model'], missing: [], ok: true },
  github: { repo: 'marota/human-ai-collaboration', data_repo: 'marota/eu-hai-collab-map', ok: true, account: 'marota', dry_run: true },
  layers: ['project', 'team', 'commons', 'framework'],
};

const FIELDS = [
  { path: 'id', kind: 'text', label: 'Slug', required: true, vocab: [], help: '', secondary: false },
  { path: 'name', kind: 'text', label: 'Name', required: true, vocab: [], help: '', secondary: false },
  { path: 'type', kind: 'select', label: 'Type', required: true, vocab: ['research_lab', 'industrial_rd'], help: '', secondary: false },
  { path: 'location.country', kind: 'text', label: 'Country', required: true, vocab: [], help: 'ISO 3166-1 alpha-2', secondary: false },
  { path: 'location.city', kind: 'text', label: 'City', required: true, vocab: [], help: '', secondary: false },
  { path: 'focus_areas', kind: 'multi', label: 'Focus areas', required: true, vocab: ['decision_support', 'oversight'], help: '', secondary: false },
  { path: 'project_ids', kind: 'ids', label: 'Projects', required: false, vocab: [], help: '', secondary: false },
  { path: 'consortium', kind: 'orgs', label: 'Consortium', required: false, vocab: [], help: '', secondary: false },
  { path: 'description', kind: 'long', label: 'Description', required: true, vocab: [], help: '', secondary: false },
  { path: 'tier', kind: 'select', label: 'Scope', required: false, vocab: ['core', 'ecosystem'], help: '', secondary: true },
];

const CARD = {
  id: 'example-grid-lab',
  name: 'Example Grid Lab',
  type: 'research_lab',
  location: { country: 'NL', city: 'Delft' },
  focus_areas: ['decision_support'],
  description: 'A lab working on control-room decision support for grid operators.',
};

const ndjson = (events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

/** Stub chat/server.py. `calls` collects every request body for assertions. */
async function stubServer(page, overrides = {}) {
  const calls = [];
  const json = (route, payload) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(payload),
  });
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let body = null;
    try { body = route.request().postDataJSON(); } catch { body = null; }
    calls.push({ path, body });
    if (overrides[path]) return overrides[path](route, body, json);
    if (path === '/api/health') return json(route, HEALTH);
    if (path === '/api/chat') {
      return route.fulfill({
        status: 200, contentType: 'application/x-ndjson',
        body: ndjson([
          { t: 'retrieved', ids: ['rte-rd-grid-ai', 'grid2op'] },
          { t: 'delta', text: 'In France, [RTE — R&D Grid AI](#rte-rd-grid-ai) runs ' },
          { t: 'delta', text: 'the [Grid2Op](#grid2op) ecosystem, and [Nowhere Lab](#nowhere-lab) does not exist.' },
          { t: 'done' },
        ]),
      });
    }
    if (path === '/api/reference') {
      return json(route, {
        reference: { url: body.url, ok: true, confirms: true, title: 'Example Lab — Home', status: 200, fetched_at: '2026-10-26T12:00:00' },
        summary: 'Reference read — “Example Lab — Home”. It does mention Example Grid Lab.',
        chars: 2048,
      });
    }
    if (path === '/api/draft') {
      return json(route, {
        mode: body.mode, layer: 'team', target: null,
        card: JSON.parse(JSON.stringify(CARD)), current: null, changed: [],
        fields: FIELDS,
        report: { ok: false, errors: [{ path: 'provenance.added_by', message: 'is required' }], warnings: [] },
        yaml: 'id: example-grid-lab\nname: Example Grid Lab\n',
        reference: { url: body.reference_url, ok: true, confirms: true, title: 'Example Lab — Home' },
      });
    }
    if (path === '/api/validate') {
      return json(route, {
        report: { ok: true, errors: [], warnings: [] },
        yaml: `id: ${body.card.id}\nname: ${body.card.name}\n`,
        changed: [],
      });
    }
    if (path === '/api/issue') {
      if (body.preview) {
        return json(route, {
          preview: true, title: 'Map data: add Example Grid Lab (team)',
          body: '### Proposed YAML\n```yaml\nid: example-grid-lab\n```',
          repo: 'marota/human-ai-collaboration', report: { ok: true, errors: [], warnings: [] },
        });
      }
      return json(route, {
        url: 'https://github.com/marota/human-ai-collaboration/issues/42',
        repo: 'marota/human-ai-collaboration', dry_run: true, title: body.title,
      });
    }
    return json(route, { error: 'unexpected endpoint' });
  });
  return calls;
}

// ================================================================ the opt-in ==

test.describe('§18.1 the opt-in', () => {
  test('without ?chat=1 there is no chat, and hai-chat.js is never asked for', async ({ page }) => {
    const seen = [];
    page.on('request', (r) => seen.push(new URL(r.url()).pathname));
    await openMap(page);
    expect(seen.filter((p) => p.includes('hai-chat'))).toEqual([]);
    await expect(page.locator('#chat-pill')).toHaveCount(0);
    await expect(page.locator('#chat')).toHaveCount(0);
    expect(await page.evaluate(() => typeof window.HAI_CHAT_HOST)).toBe('undefined');
    expect(await page.evaluate(() => document.body.classList.contains('chat-open'))).toBe(false);
  });

  test('§18.1 the page itself names no network API and keeps three script tags', async ({}, testInfo) => {
    // The guard is twenty lines of the page; everything that touches the
    // network lives in the file it appends. integrity.spec.js asserts the
    // absence of fetch( over the whole script — this is the other half: the
    // opt-in is the only mention of the chat, and it is behind the parameter.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const html = await fs.readFile(
      path.resolve(testInfo.project.testDir, '../..', 'assets/map/eu-hai-map.html'), 'utf8');
    // One assignment, and it is inside the guard. (The prose above it names
    // the file too, which is the point of the prose.)
    expect((html.match(/src = 'hai-chat\.js'/g) || []).length).toBe(1);
    expect(html).toContain("get('chat') === '1'");
    const guard = html.slice(html.indexOf("get('chat') === '1'"));
    expect(guard).toContain("src = 'hai-chat.js'");
    expect((html.match(/<script\b[^>]*>/g) || []).length).toBe(3);
  });

  test('with ?chat=1 the column arrives, open, and asks the server how it is', async ({ page }) => {
    const calls = await stubServer(page);
    await openMap(page, CHAT);
    await expect(page.locator('#chat')).toBeVisible();
    await expect(page.locator('#chat-pill')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => calls.filter((c) => c.path === '/api/health').length).toBe(1);
    await expect(page.locator('#ch-state')).toContainText('test-model');
    await expect(page.locator('#ch-state .ch-dot.on')).toBeVisible();
  });

  test('§5 the column takes the feed\'s place and gives it back', async ({ page }) => {
    await stubServer(page);
    await openMap(page, CHAT);
    // Opening the chat closes the feed rather than squeezing a fourth column
    // into a grid that already has to fit the floating clusters (invariant 11).
    expect(await page.evaluate(() => document.body.classList.contains('feed-open'))).toBe(false);
    await page.click('#chat-pill');
    await expect(page.locator('#chat')).toBeHidden();
    expect(await page.evaluate(() => document.body.classList.contains('feed-open'))).toBe(true);
    await page.click('#chat-pill');
    await expect(page.locator('#chat')).toBeVisible();
  });

  test('a server that is not there is explained, not left silent', async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort('connectionrefused'));
    await openMap(page, CHAT);
    await expect(page.locator('.ch-msg.sys')).toContainText('python3 chat/server.py');
    await expect(page.locator('#ch-input')).toBeDisabled();
  });

  test('a model that is not pulled says which command fixes it', async ({ page }) => {
    await stubServer(page, {
      '/api/health': (route, body, json) => json(route, {
        ...HEALTH,
        model: { ...HEALTH.model, missing: ['test-model'], ok: false },
      }),
    });
    await openMap(page, CHAT);
    await expect(page.locator('.ch-msg.sys')).toContainText('ollama pull test-model');
  });
});

// ============================================================ the conversation ==

test.describe('§18.2 answering', () => {
  test('the reply streams in, and the cards it rests on are listed', async ({ page }) => {
    const calls = await stubServer(page);
    await openMap(page, CHAT);
    await page.fill('#ch-input', 'who works on grids in France?');
    await page.click('#ch-send');
    await expect(page.locator('.ch-msg.bot').last()).toContainText('In France');
    await expect(page.locator('.ch-src .ch-chip')).toHaveCount(2);
    // The chips name the cards, not the ids: the reader recognises the name.
    await expect(page.locator('.ch-src .ch-chip').first()).toContainText('RTE');
    const chat = calls.find((c) => c.path === '/api/chat');
    expect(chat.body.lang).toBe('en');
    expect(chat.body.messages.at(-1)).toEqual({
      role: 'user', content: 'who works on grids in France?',
    });
  });

  test('a card link opens the card; an id that is not a card is not a link', async ({ page }) => {
    await stubServer(page);
    await openMap(page, CHAT);
    await page.fill('#ch-input', 'who works on grids?');
    await page.click('#ch-send');
    const bot = page.locator('.ch-msg.bot').last();
    await expect(bot.locator('a[data-card="rte-rd-grid-ai"]')).toBeVisible();
    // invariant: the renderer only linkifies an id that is in byId, so a model
    // that invents one leaves prose behind rather than a dead link.
    await expect(bot).toContainText('Nowhere Lab');
    await expect(bot.locator('a[data-card="nowhere-lab"]')).toHaveCount(0);
    await bot.locator('a[data-card="rte-rd-grid-ai"]').click();
    expect(await page.evaluate(() => state.focusId)).toBe('rte-rd-grid-ai');
  });

  test('a chip opens the card too', async ({ page }) => {
    await stubServer(page);
    await openMap(page, CHAT);
    await page.fill('#ch-input', 'who works on grids?');
    await page.click('#ch-send');
    await page.locator('.ch-src .ch-chip').nth(1).click();
    expect(await page.evaluate(() => state.focusId)).toBe('grid2op');
  });

  test('§13 the conversation is kept on the device, and Clear ends it', async ({ page }) => {
    // Asserted through localStorage rather than through a reload: openMap()
    // clears storage on every navigation by design, so a reload here would
    // test the harness instead of the column.
    const stored = () => page.evaluate(() => localStorage.getItem('hai-map-chat-log'));
    await stubServer(page);
    await openMap(page, CHAT);
    await page.fill('#ch-input', 'who works on grids?');
    await page.click('#ch-send');
    await expect(page.locator('.ch-msg.bot').last()).toContainText('In France');
    await expect.poll(stored).toContain('who works on grids?');
    // The conversation, and nothing else: no reference, no draft, no card.
    expect(JSON.parse(await stored()).map((m) => m.role)).toEqual(['user', 'assistant']);
    await page.click('#ch-clear');
    await expect(page.locator('.ch-msg.me')).toHaveCount(0);
    expect(await stored()).toBe('[]');
  });

  test('§12 the column follows the language switch', async ({ page }) => {
    await stubServer(page);
    await openMap(page, CHAT, { lang: 'en' });
    await expect(page.locator('#ch-send')).toHaveText('Send');
    await page.click('.lang-switch button[data-lang="fr"]');
    await expect(page.locator('#ch-send')).toHaveText('Envoyer');
    await expect(page.locator('#ch-input')).toHaveAttribute('placeholder', /Posez une question/);
    const calls = await stubServer(page);
    await page.fill('#ch-input', 'qui travaille sur les réseaux ?');
    await page.click('#ch-send');
    await expect.poll(() => (calls.find((c) => c.path === '/api/chat') || {}).body?.lang).toBe('fr');
  });
});

// ============================================================== the proposal ==

test.describe('§18.3 proposing a change', () => {
  async function propose(page, event = { t: 'propose', mode: 'add', target: 'team' }) {
    const calls = await stubServer(page, {
      '/api/chat': (route) => route.fulfill({
        status: 200, contentType: 'application/x-ndjson',
        body: ndjson([
          { t: 'retrieved', ids: [] },
          event,
          { t: 'delta', text: 'You want to add a team. Which page documents it?' },
          { t: 'done' },
        ]),
      }),
    });
    await openMap(page, CHAT);
    await page.fill('#ch-input', 'the Example Grid Lab is missing');
    await page.click('#ch-send');
    await expect(page.locator('.ch-prop')).toBeVisible();
    return calls;
  }

  test('a propose event opens the panel at the reference, not at a form', async ({ page }) => {
    await propose(page);
    await expect(page.locator('.ch-prop-t')).toContainText('Propose an addition');
    await expect(page.locator('.ch-prop-s')).toContainText('1 ·');
    await expect(page.locator('[data-prop="url"]')).toBeVisible();
    // The reply itself must not have shown the control line.
    await expect(page.locator('.ch-msg.bot').last()).not.toContainText('PROPOSE');
    await expect(page.locator('.ch-msg.bot').last()).toContainText('Which page documents it?');
  });

  test('the reference is checked and the verdict is shown before anything is drafted', async ({ page }) => {
    const calls = await propose(page);
    await page.fill('[data-prop="name"]', 'Example Grid Lab');
    await page.fill('[data-prop="url"]', 'https://example.org/lab');
    await page.click('[data-act="check"]');
    await expect(page.locator('.ch-state.ok')).toContainText('It does mention');
    const ref = calls.find((c) => c.path === '/api/reference');
    expect(ref.body).toMatchObject({ url: 'https://example.org/lab', name: 'Example Grid Lab' });
    // Still step 1: checking a reference drafts nothing.
    expect(calls.filter((c) => c.path === '/api/draft')).toEqual([]);
  });

  test('the draft becomes a form built from the field table the server sent', async ({ page }) => {
    const calls = await propose(page);
    await page.fill('[data-prop="url"]', 'https://example.org/lab');
    await page.click('[data-act="draft"]');
    await expect(page.locator('.ch-prop-s')).toContainText('2 ·');
    // Pre-filled from the draft…
    await expect(page.locator('[data-field="name"]')).toHaveValue('Example Grid Lab');
    await expect(page.locator('[data-field="location.city"]')).toHaveValue('Delft');
    await expect(page.locator('[data-field="type"]')).toHaveValue('research_lab');
    await expect(page.locator('[data-field="focus_areas"] input[value="decision_support"]'))
      .toBeChecked();
    // …and honest about what is still missing, which is the whole point of
    // asking while the contributor is still here.
    await expect(page.locator('.ch-state.warn')).toContainText('required field');
    // A secondary field is present but folded away.
    await expect(page.locator('[data-field="tier"]')).toBeHidden();
    await page.locator('.ch-fold summary', { hasText: 'Further fields' }).click();
    await expect(page.locator('[data-field="tier"]')).toBeVisible();
    expect(calls.find((c) => c.path === '/api/draft').body)
      .toMatchObject({ mode: 'add', target: 'team', reference_url: 'https://example.org/lab' });
  });

  test('editing a field re-validates against the server', async ({ page }) => {
    const calls = await propose(page);
    await page.click('[data-act="draft"]');
    await expect(page.locator('[data-field="name"]')).toBeVisible();
    await page.fill('[data-field="name"]', 'Renamed Grid Lab');
    await expect.poll(() => calls.filter((c) => c.path === '/api/validate').length)
      .toBeGreaterThan(0);
    const sent = calls.filter((c) => c.path === '/api/validate').at(-1);
    expect(sent.body.card.name).toBe('Renamed Grid Lab');
    expect(sent.body.layer).toBe('team');
    await expect(page.locator('.ch-state.ok')).toContainText('passes its checks');
  });

  test('a multi-value field, an id list and a consortium row all read back', async ({ page }) => {
    const calls = await propose(page);
    await page.click('[data-act="draft"]');
    await expect(page.locator('[data-field="name"]')).toBeVisible();
    await page.check('[data-field="focus_areas"] input[value="oversight"]');
    await page.fill('[data-field="project_ids"]', 'ai4realnet, grid2op');
    await page.fill('[data-field="consortium"] .ch-orgrow input[data-k="org"]', 'Example University');
    await page.fill('[data-field="consortium"] .ch-orgrow input[data-k="country"]', 'nl');
    await expect.poll(() => {
      const last = calls.filter((c) => c.path === '/api/validate').at(-1);
      return last && last.body.card.consortium?.[0]?.country;
    }).toBe('NL');
    const card = calls.filter((c) => c.path === '/api/validate').at(-1).body.card;
    expect(card.focus_areas).toEqual(['decision_support', 'oversight']);
    expect(card.project_ids).toEqual(['ai4realnet', 'grid2op']);
    expect(card.consortium[0].org).toBe('Example University');
  });

  test('the issue is previewed in full, then opened on one click — with the edits', async ({ page }) => {
    const calls = await propose(page);
    await page.click('[data-act="draft"]');
    await expect(page.locator('[data-field="name"]')).toBeVisible();
    await page.fill('[data-field="name"]', 'Renamed Grid Lab');
    await expect.poll(() => calls.filter((c) => c.path === '/api/validate').length)
      .toBeGreaterThan(0);

    await page.click('[data-act="preview"]');
    await expect(page.locator('.ch-prop-s')).toContainText('3 ·');
    await expect(page.locator('.ch-fold pre')).toContainText('Proposed YAML');
    const preview = calls.filter((c) => c.path === '/api/issue').at(-1);
    expect(preview.body.preview).toBe(true);
    expect(preview.body.card.name).toBe('Renamed Grid Lab');
    expect(preview.body.transcript).toContain('Contributor: the Example Grid Lab is missing');

    await page.click('[data-act="post"]');
    await expect(page.locator('.ch-state.ok')).toContainText('Issue opened');
    await expect(page.locator('.ch-state.ok a')).toHaveAttribute(
      'href', 'https://github.com/marota/human-ai-collaboration/issues/42');
    const posted = calls.filter((c) => c.path === '/api/issue').at(-1);
    // invariant 16: what the contributor read is what was posted, and it took
    // a deliberate click to post it.
    expect(posted.body.preview).toBeFalsy();
    expect(posted.body.card.name).toBe('Renamed Grid Lab');
  });

  test('nothing is posted while the checks fail', async ({ page }) => {
    await propose(page);
    await page.click('[data-act="draft"]');
    await expect(page.locator('.ch-state.warn')).toBeVisible();
    await expect(page.locator('[data-act="preview"]')).toBeDisabled();
  });

  test('a correction starts from the card on the map and shows what moves', async ({ page }) => {
    const calls = await stubServer(page, {
      '/api/chat': (route) => route.fulfill({
        status: 200, contentType: 'application/x-ndjson',
        body: ndjson([
          { t: 'retrieved', ids: ['rte-rd-grid-ai'] },
          { t: 'propose', mode: 'fix', target: 'rte-rd-grid-ai' },
          { t: 'delta', text: 'Which page says so?' },
          { t: 'done' },
        ]),
      }),
      '/api/draft': (route, body, json) => json(route, {
        mode: 'fix', layer: 'team', target: 'rte-rd-grid-ai',
        card: { ...CARD, id: 'rte-rd-grid-ai', name: 'RTE — R&D Grid AI', status: 'concluded' },
        current: { id: 'rte-rd-grid-ai', name: 'RTE — R&D Grid AI', status: 'active' },
        changed: [{ path: 'status', before: 'active', after: 'concluded' }],
        fields: FIELDS, report: { ok: true, errors: [], warnings: [] },
        yaml: 'id: rte-rd-grid-ai\n', reference: null,
      }),
    });
    await openMap(page, CHAT);
    await page.fill('#ch-input', 'the RTE card is out of date');
    await page.click('#ch-send');
    await expect(page.locator('.ch-prop-t')).toContainText('Propose a correction');
    await expect(page.locator('.ch-prop-t')).toContainText('RTE');
    await page.click('[data-act="draft"]');
    await expect(page.locator('.ch-diff')).toBeVisible();
    await expect(page.locator('.ch-diff tbody tr')).toHaveCount(1);
    await expect(page.locator('.ch-diff td').nth(1)).toHaveText('active');
    await expect(page.locator('.ch-diff td.now')).toHaveText('concluded');
    expect(calls.find((c) => c.path === '/api/draft').body)
      .toMatchObject({ mode: 'fix', target: 'rte-rd-grid-ai' });
  });

  test('giving up leaves no proposal behind', async ({ page }) => {
    await propose(page);
    await page.click('[data-act="cancel"]');
    await expect(page.locator('.ch-prop')).toHaveCount(0);
    await expect(page.locator('.ch-msg.bot').last()).toBeVisible();
  });

  test('a server error on drafting is reported rather than swallowed', async ({ page }) => {
    await stubServer(page, {
      '/api/chat': (route) => route.fulfill({
        status: 200, contentType: 'application/x-ndjson',
        body: ndjson([{ t: 'propose', mode: 'add', target: 'team' },
          { t: 'delta', text: 'Which page?' }, { t: 'done' }]),
      }),
      '/api/draft': (route) => route.fulfill({
        status: 502, contentType: 'application/json',
        body: JSON.stringify({ error: 'the draft was cut off after 10022 characters' }),
      }),
    });
    await openMap(page, CHAT);
    await page.fill('#ch-input', 'a lab is missing');
    await page.click('#ch-send');
    await page.click('[data-act="draft"]');
    await expect(page.locator('.ch-state.bad')).toContainText('cut off');
    // …and the contributor is back where they can try again.
    await expect(page.locator('[data-act="draft"]')).toBeEnabled();
  });
});

// ================================================================= escaping ==

test.describe('§18 invariant 9 — the chat escapes what it renders', () => {
  test('markup in a model reply, in a card name and in a server message is inert', async ({ page }) => {
    await stubServer(page, {
      '/api/chat': (route) => route.fulfill({
        status: 200, contentType: 'application/x-ndjson',
        body: ndjson([
          { t: 'retrieved', ids: [] },
          { t: 'delta', text: '<img src=x onerror="window.__xss=1"> and **bold** and `code`' },
          { t: 'done' },
        ]),
      }),
    });
    await openMap(page, CHAT);
    await page.fill('#ch-input', 'try it');
    await page.click('#ch-send');
    const bot = page.locator('.ch-msg.bot').last();
    await expect(bot).toContainText('<img src=x');
    await expect(bot.locator('img')).toHaveCount(0);
    // The small markdown still works on the escaped text.
    await expect(bot.locator('strong')).toHaveText('bold');
    await expect(bot.locator('code')).toHaveText('code');
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  });

  test('a javascript: url in a reply is not turned into a link', async ({ page }) => {
    await stubServer(page, {
      '/api/chat': (route) => route.fulfill({
        status: 200, contentType: 'application/x-ndjson',
        body: ndjson([
          { t: 'delta', text: 'see [this](javascript:alert(1)) and [that](https://example.org/x)' },
          { t: 'done' },
        ]),
      }),
    });
    await openMap(page, CHAT);
    await page.fill('#ch-input', 'try it');
    await page.click('#ch-send');
    const bot = page.locator('.ch-msg.bot').last();
    expect(await bot.locator('a').count()).toBe(1);
    await expect(bot.locator('a')).toHaveAttribute('href', 'https://example.org/x');
    await expect(bot.locator('a')).toHaveAttribute('target', '_blank');
  });
});
