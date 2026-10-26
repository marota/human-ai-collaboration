# Tests

Coverage of [`docs/map-interface-spec.md`](../docs/map-interface-spec.md) and the code it
specifies: the ecosystem map (`assets/map/eu-hai-map.html`) and its generator
(`scripts/build-map-data.py`).

**1 130 tests** — 758 in a real browser, 372 in Python. Every test names the spec claim it
defends, so a failure says which claim broke rather than only which assertion did.

## Running them

```bash
npm install && npx playwright install chromium   # once
npm test                                         # everything
```

```bash
npm run test:interface     # Playwright only
npm run test:python        # generator + payload only
npm run test:ui            # Playwright's watch UI
```

Individual files:

```bash
npx playwright test tests/interface/counters.spec.js --workers=1
python3 -m unittest tests.generator.test_domain_mapping -v
```

## Why a browser

The spec is mostly claims about a running interface — counters that reconcile *at every zoom
level*, floating clusters that must not overflow a clipped stage, labels that must not clip,
markers whose shape encodes the layer. None of that survives a DOM emulator with no layout
engine: `getBoundingClientRect()` returns zeros and the interesting half of the specification
becomes unassertable. So the interface tests drive a real Chromium against the real file.

**This costs the repository a dev dependency, and nothing else.** The published page still loads
three local files and makes no network request — [`integrity.spec.js`](interface/integrity.spec.js)
asserts exactly that, which is the one invariant a test harness could plausibly erode.

## Layout

| Path | Runner | Covers |
|---|---|---|
| `tests/interface/*.spec.js` | Playwright + Chromium | the running page |
| `tests/generator/*.py` | `unittest` (stdlib) | `scripts/build-map-data.py`, against synthetic fixtures |
| `tests/data/*.py` | `unittest` (stdlib) | the committed `hai-data.js` payload |
| `tests/fixtures/` | — | synthetic YAML trees, prefixed per test module |

The Python side has **no dependencies at all** — `unittest` and `PyYAML`, which the generator
already requires. The generator tests never need the `eu-hai-collab-map` checkout: they build
from fixtures, so they run anywhere.

## Reaching the page's internals

The map is one classic `<script>`, so its top-level `const` bindings and function declarations
live in the global lexical environment rather than on `window`. `page.evaluate()` runs in that
same scope, so a bare `state`, `matchesFilters`, `periodState` or `I18N` resolves:

```js
const s = await page.evaluate(() => ({ match: state.matchCount, kept: state.keptOpen }));
```

That means **the tests exercise the file that ships**, with no instrumentation build and no
export shims. `tests/interface/_map.js` wraps the common moves; read it before writing a test.

`tests/_harness.py` does the equivalent on the Python side: it loads `build-map-data.py` by path
(the hyphen makes it unimportable by name) and parses the generated `hai-data.js` back into
Python objects without a JS runtime.

## Conventions

- **Every test names its spec reference**, e.g. `test('§9.2 in view + off screen + off the map
  reconciles at every zoom', ...)`. A failure should say which claim broke, not just which
  assertion did.
- **Tests must be falsifiable.** Exact numbers and exact strings over `toBeTruthy()`. Where a
  test asserts a count, the expectation is derived independently — from the data payload or from
  the spec's stated rule — rather than read back out of the code path under test.
- **`// SPEC-DEVIATION:`** marks a test that asserts current behaviour where the implementation
  and the spec disagree. These are deliberate: the test pins what the code does today so the
  disagreement is visible and can be resolved on purpose rather than discovered by accident.

## Mutation checking

A green suite proves nothing on its own — what matters is whether it can go red. Every file here
was verified by breaking the implementation in targeted ways and checking that the tests noticed.
The page under test is selected by `MAP_PATH`, so a doctored copy can sit beside the real one
(where its relative `<script src>` still resolves) and be pointed at:

```bash
cp assets/map/eu-hai-map.html assets/map/.mut-x.html
# break something in the copy
MAP_PATH=/assets/map/.mut-x.html PW_OUTPUT_DIR=/tmp/pw-x \
  npx playwright test tests/interface/counters.spec.js --workers=2
# expect failures; then delete the mutant
```

`assets/map/.mut-*.html` is gitignored. `PW_OUTPUT_DIR` matters only when two runs share this
checkout: without it they delete each other's traces mid-write and you get ENOENT failures in
tests that are fine.

**Of 129 mutations, 48 were initially missed.** All 48 are now caught — the gaps they exposed
became 37 new tests, and 60 assertions that could not fail were rewritten. The pattern worth
remembering: the misses were almost never in the logic a test *names*, but in what it never
looked at. Nothing read where the period slider *draws* its handles, so both could land on one
pixel while the label stayed correct and 57 tests passed. No test fed the page a hostile string,
so `esc()` could be deleted from four call sites unnoticed. Pin fixtures happened to be in
alphabetical order, so four tests that promised to check ordering could not fail on it.

Use this when adding a test: one that still passes against a deliberately broken page is not a
test.
