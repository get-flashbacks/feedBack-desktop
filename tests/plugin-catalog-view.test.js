// Read-only catalog view (issue #15) and its cards (issue #16, catalog UI
// 2/5). src/renderer/plugin-manager/screen.js carries its search, filter and
// badge semantics in five IIFE-free functions so this suite can lift them out
// by source and pin them: pmCatalogState, pmCatalogBadges, pmCatalogHaystack,
// pmCatalogFacets and pmFilterCatalog. The rendered card itself is checked
// through a DOM stub below — the view is all that is tested here; installing
// is issue #18 (4/5).
//
// The install list below the view (issue #17, catalog UI 3/5) is built by the
// same screen script and the same DOM stub, so its render and the note it
// writes before anything is downloaded are pinned here too: this suite is
// where the whole-screen harness lives.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SCREEN_JS = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'plugin-manager', 'screen.js'), 'utf8');
const CATALOG_JSON = path.join(ROOT, 'resources', 'plugin-catalog.json');

const { loadTs } = require('./_load-ts');
const { PLUGIN_API_VERSION, compatibilityFor } = loadTs('src/main/plugin-compat.ts');

// The verdict this build's listCatalog() would reach for the fixture's
// declaration, computed by the real rule rather than copied: a phrasing change
// in plugin-compat.ts would otherwise leave the fixture — and every card
// assertion built on it — quietly stale while the app said something else.
const FIXTURE_BUILD = {
    coreVersion: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
    pluginApiVersion: PLUGIN_API_VERSION,
};

// Same brace-matching lift the audio screen suite uses: the function text is
// compiled as-is, so these five must stay free of template literals (their
// braces would confuse the counter) and of any reference to the IIFE scope.
const PURE_FUNCTIONS = ['pmCatalogState', 'pmCatalogBadges', 'pmCatalogHaystack', 'pmCatalogFacets', 'pmFilterCatalog'];

function extractFunction(src, name) {
    const sig = `function ${name}(`;
    const start = src.indexOf(sig);
    assert.ok(start !== -1, `function '${name}' not found in screen.js`);
    let i = src.indexOf('{', src.indexOf(')', start));
    let depth = 1;
    i++;
    while (i < src.length && depth > 0) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        i++;
    }
    assert.ok(depth === 0, `unbalanced braces in '${name}'`);
    return src.slice(start, i);
}

function loadView() {
    // runInThisContext, not runInNewContext: the returned arrays must share this
    // realm's Array.prototype for deepStrictEqual to accept them.
    return vm.runInThisContext(
        '(() => {\n'
        + PURE_FUNCTIONS.map((name) => extractFunction(SCREEN_JS, name)).join('\n')
        + '\nreturn { pmCatalogState, pmCatalogBadges, pmCatalogHaystack, pmCatalogFacets, pmFilterCatalog };\n'
        + '})()'
    );
}

const view = loadView();

// A catalog row as plugins:catalog answers it: every catalog field plus the
// install state the main process derived from disk.
function entry(overrides) {
    return {
        id: 'example',
        installDir: 'example',
        name: 'Example',
        description: 'An example plugin.',
        repository: 'https://github.com/get-flashbacks/feedback-plugin-example',
        version: '1.0.0',
        commit: 'a'.repeat(40),
        archiveSha256: 'b'.repeat(64),
        source: 'get-flashbacks',
        category: 'practice',
        instruments: ['guitar'],
        stability: 'stable',
        compatibility: { minCoreVersion: '0.3.0', minPluginApiVersion: '1' },
        dependencies: [],
        conflicts: [],
        size: { downloadBytes: 1024, installedBytes: 4096 },
        selection: { tier: 'optional', defaultSelected: false },
        installedVersion: null,
        bundled: false,
        activeSource: 'none',
        canRollback: false,
        // The verdict listCatalog() derives from the declaration above against
        // this build — the shape src/main/plugin-compat.ts produces.
        compat: compatibilityFor(
            { name: 'Example', compatibility: { minCoreVersion: '0.3.0', minPluginApiVersion: '1' } },
            FIXTURE_BUILD
        ),
        ...overrides,
    };
}

const CATALOG = [
    entry({ id: 'alpha', name: 'Practice Alpha', description: 'Accuracy-driven difficulty.', instruments: ['guitar'] }),
    entry({
        id: 'beta',
        name: 'Practice Beta',
        description: 'Phrase-level ladder.',
        source: 'upstream-official',
        stability: 'beta',
        instruments: ['guitar', 'keys'],
        version: '2.1.0',
        installedVersion: '2.1.0',
    }),
    entry({
        id: 'gamma',
        name: 'Tools Gamma',
        description: 'Imports Guitar Pro files.',
        category: 'tools',
        source: 'reviewed-community',
        stability: 'experimental',
        instruments: [],
    }),
    entry({
        id: 'delta',
        name: 'Visual Delta',
        description: 'Song-section map.',
        category: 'visualization',
        instruments: ['vocals'],
        version: '1.2.0',
        installedVersion: '1.0.0',
    }),
    entry({
        id: 'epsilon',
        name: 'Bundled Epsilon',
        description: 'Ships with the desktop.',
        category: 'tools',
        instruments: ['keys'],
        bundled: true,
    }),
];

function filters(overrides) {
    return {
        query: '',
        category: new Set(),
        instrument: new Set(),
        source: new Set(),
        stability: new Set(),
        state: new Set(),
        ...overrides,
    };
}

function ids(rows) {
    return rows.map((row) => row.id).sort();
}

function search(rows, query, overrides) {
    return ids(view.pmFilterCatalog(rows, filters({ query, ...overrides })));
}

// ── The script parses as a whole ─────────────────────────────────────

test('screen.js parses as a whole, not just the five lifted functions', () => {
    // loadView() only compiles the five lifted functions, so everything else in
    // the IIFE — including the shared esc() helper — is unchecked here. A merge
    // that reintroduced a duplicate `const esc` parsed fine in isolation and
    // still threw a SyntaxError in the renderer, blanking the whole screen.
    // Compile the file untouched: new vm.Script parses without executing, so no
    // window or document is needed.
    assert.doesNotThrow(() => new vm.Script(SCREEN_JS, { filename: 'screen.js' }));
});

// ── Search ───────────────────────────────────────────────────────────

test('search matches names case-insensitively', () => {
    assert.deepEqual(search(CATALOG, 'alpha'), ['alpha']);
    assert.deepEqual(search(CATALOG, 'ALPHA'), ['alpha']);
    assert.deepEqual(search(CATALOG, 'pract'), ['alpha', 'beta']);
});

test('search also matches descriptions, ids and instrument names', () => {
    assert.deepEqual(search(CATALOG, 'guitar pro'), ['gamma']);
    assert.deepEqual(search(CATALOG, 'delta'), ['delta']);
    assert.deepEqual(search(CATALOG, 'section'), ['delta']);
    assert.deepEqual(search(CATALOG, 'vocals'), ['delta']);
});

test('search terms are ANDed, so an extra word narrows the result', () => {
    assert.deepEqual(search(CATALOG, 'practice'), ['alpha', 'beta']);
    assert.deepEqual(search(CATALOG, 'practice keys'), ['beta']);
    assert.deepEqual(search(CATALOG, 'practice vocals'), []);
});

test('a blank or whitespace-only search is not a constraint', () => {
    assert.deepEqual(search(CATALOG, ''), ['alpha', 'beta', 'delta', 'epsilon', 'gamma']);
    assert.deepEqual(search(CATALOG, '   '), ['alpha', 'beta', 'delta', 'epsilon', 'gamma']);
});

// ── Each filter ──────────────────────────────────────────────────────

test('the category filter keeps only that category', () => {
    const rows = CATALOG;
    assert.deepEqual(ids(view.pmFilterCatalog(rows, filters({ category: new Set(['tools']) }))), ['epsilon', 'gamma']);
    assert.deepEqual(ids(view.pmFilterCatalog(rows, filters({ category: new Set(['practice']) }))), ['alpha', 'beta']);
    assert.deepEqual(ids(view.pmFilterCatalog(rows, filters({ category: new Set(['nope']) }))), []);
});

test('the instrument filter keeps entries that list it and drops entries that list nothing', () => {
    const rows = CATALOG;
    assert.deepEqual(ids(view.pmFilterCatalog(rows, filters({ instrument: new Set(['guitar']) }))), ['alpha', 'beta']);
    // gamma declares no instruments, so the catalog says nothing about where it
    // applies — an instrument filter must exclude it rather than include it.
    assert.deepEqual(ids(view.pmFilterCatalog(rows, filters({ instrument: new Set(['vocals']) }))), ['delta']);
    assert.deepEqual(ids(view.pmFilterCatalog(rows, filters({ instrument: new Set(['bass']) }))), []);
});

test('the source filter keeps only that source', () => {
    const rows = CATALOG;
    assert.deepEqual(
        ids(view.pmFilterCatalog(rows, filters({ source: new Set(['reviewed-community']) }))),
        ['gamma']
    );
    assert.deepEqual(
        ids(view.pmFilterCatalog(rows, filters({ source: new Set(['upstream-official']) }))),
        ['beta']
    );
    assert.deepEqual(
        ids(view.pmFilterCatalog(rows, filters({ source: new Set(['get-flashbacks']) }))),
        ['alpha', 'delta', 'epsilon']
    );
});

test('the stability filter keeps only that stability', () => {
    const rows = CATALOG;
    assert.deepEqual(ids(view.pmFilterCatalog(rows, filters({ stability: new Set(['stable']) }))), [
        'alpha', 'delta', 'epsilon',
    ]);
    assert.deepEqual(ids(view.pmFilterCatalog(rows, filters({ stability: new Set(['beta']) }))), ['beta']);
    assert.deepEqual(ids(view.pmFilterCatalog(rows, filters({ stability: new Set(['experimental']) }))), ['gamma']);
});

test('the state filter separates installed, available and update-available', () => {
    const rows = CATALOG;
    assert.deepEqual(ids(view.pmFilterCatalog(rows, filters({ state: new Set(['available']) }))), [
        'alpha', 'gamma',
    ]);
    // beta matches its pinned version, epsilon ships with the app.
    assert.deepEqual(ids(view.pmFilterCatalog(rows, filters({ state: new Set(['installed']) }))), [
        'beta', 'epsilon',
    ]);
    assert.deepEqual(ids(view.pmFilterCatalog(rows, filters({ state: new Set(['update-available']) }))), ['delta']);
});

// ── Combining and clearing ───────────────────────────────────────────

test('values inside one facet are ORed and separate facets are ANDed', () => {
    const rows = CATALOG;
    assert.deepEqual(
        ids(view.pmFilterCatalog(rows, filters({ category: new Set(['practice', 'tools']) }))),
        ['alpha', 'beta', 'epsilon', 'gamma']
    );
    assert.deepEqual(
        ids(view.pmFilterCatalog(rows, filters({
            category: new Set(['practice', 'tools']),
            stability: new Set(['stable']),
        }))),
        ['alpha', 'epsilon']
    );
    // Search combines with the facets rather than replacing them.
    assert.deepEqual(
        search(rows, 'ladder', { category: new Set(['practice']), source: new Set(['get-flashbacks']) }),
        []
    );
    assert.deepEqual(search(rows, 'ladder', { category: new Set(['practice']) }), ['beta']);
});

test('clearing every filter restores the whole catalog', () => {
    const rows = CATALOG;
    const narrowed = filters({
        query: 'practice',
        category: new Set(['practice']),
        instrument: new Set(['guitar']),
        source: new Set(['get-flashbacks']),
        stability: new Set(['stable']),
        state: new Set(['available']),
    });
    assert.deepEqual(ids(view.pmFilterCatalog(rows, narrowed)), ['alpha']);

    // This is what the clear button does: empty every set and blank the query.
    const cleared = filters();
    assert.deepEqual(ids(view.pmFilterCatalog(rows, cleared)), ['alpha', 'beta', 'delta', 'epsilon', 'gamma']);
});

test('filtering neither mutates the catalog nor reorders it', () => {
    const rows = CATALOG.map((row) => ({ ...row }));
    const before = ids(rows);
    view.pmFilterCatalog(rows, filters({ query: 'a', category: new Set(['practice']) }));
    assert.deepEqual(ids(rows), before);
    assert.deepEqual(ids(view.pmFilterCatalog(rows, filters())), before);
});

// ── Derived install state ────────────────────────────────────────────

test('install state prefers the bundled copy, then the user copy', () => {
    assert.equal(view.pmCatalogState(entry()), 'available');
    // A bundled copy is the one the backend loads, so it wins outright and is
    // never reported as upgradable.
    assert.equal(view.pmCatalogState(entry({ bundled: true })), 'installed');
    assert.equal(
        view.pmCatalogState(entry({ bundled: true, installedVersion: '0.9.0' })),
        'installed'
    );
    assert.equal(view.pmCatalogState(entry({ installedVersion: '1.0.0' })), 'installed');
    assert.equal(view.pmCatalogState(entry({ installedVersion: '0.9.0' })), 'update-available');
    // A git-installed plugin whose manifest carried no version is still present,
    // it just cannot be compared against the pinned one.
    assert.equal(view.pmCatalogState(entry({ installedVersion: '' })), 'installed');
});

// ── Facets ───────────────────────────────────────────────────────────

test('facets list every distinct value in the catalog, sorted, and drop empty ones', () => {
    const facets = view.pmCatalogFacets(CATALOG);
    assert.deepEqual(facets.category, ['practice', 'tools', 'visualization']);
    assert.deepEqual(facets.instrument, ['guitar', 'keys', 'vocals']);
    assert.deepEqual(facets.source, ['get-flashbacks', 'reviewed-community', 'upstream-official']);
    assert.deepEqual(facets.stability, ['beta', 'experimental', 'stable']);
    assert.deepEqual(facets.state, ['available', 'installed', 'update-available']);
    assert.deepEqual(view.pmCatalogFacets([]), {
        category: [], instrument: [], source: [], stability: [], state: [],
    });
});

test('facets come from the whole catalog, never from the current results', () => {
    const rows = CATALOG.filter((row) => row.category === 'practice');
    // Otherwise ticking "practice" would erase every other category option and
    // the user could not widen the selection again.
    assert.deepEqual(view.pmCatalogFacets(rows).category, ['practice']);
    assert.deepEqual(view.pmCatalogFacets(CATALOG).category, ['practice', 'tools', 'visualization']);
});

// ── The bundled catalog, offline ─────────────────────────────────────

test('the bundled catalog lists and filters with no network', () => {
    // Exactly what plugins:catalog answers when nothing is installed: the file
    // on disk plus the main process's install-state fields. Nothing here can
    // reach the network, which is the offline guarantee for this view.
    const raw = JSON.parse(fs.readFileSync(CATALOG_JSON, 'utf8'));
    const rows = raw.entries.map((row) => ({ ...row, installedVersion: null, bundled: false, activeSource: 'none', canRollback: false }));

    assert.ok(rows.length > 0, 'the bundled catalog should ship entries');
    assert.deepEqual(ids(view.pmFilterCatalog(rows, filters())), ids(rows));

    const byName = rows[0].name.split(' ')[0];
    assert.ok(search(rows, byName).length > 0, 'search should find a bundled entry by name');

    // Search and every filter stay reachable against the catalog we actually
    // ship: each facet offers at least one value, and picking it agrees with an
    // independent predicate over the same rows.
    const facetPredicates = {
        category: (row, value) => row.category === value,
        instrument: (row, value) => (row.instruments || []).includes(value),
        source: (row, value) => row.source === value,
        stability: (row, value) => row.stability === value,
        state: (row, value) => view.pmCatalogState(row) === value,
    };
    const facets = view.pmCatalogFacets(rows);
    for (const [facet, values] of Object.entries(facets)) {
        assert.ok(values.length > 0, `the bundled catalog should offer a '${facet}' filter`);
        const value = values[0];
        assert.deepEqual(
            ids(view.pmFilterCatalog(rows, filters({ [facet]: new Set([value]) }))),
            ids(rows.filter((row) => facetPredicates[facet](row, value)))
        );
    }

    // A value no bundled entry has yields an empty list, not the whole catalog.
    assert.deepEqual(ids(view.pmFilterCatalog(rows, filters({ stability: new Set(['beta']) }))), []);
    assert.deepEqual(ids(view.pmFilterCatalog(rows, filters({ source: new Set(['reviewed-community']) }))), []);
});

test('the row fields this suite builds are the ones plugins:catalog sends', () => {
    // plugin-manager.ts imports electron, so it cannot be loaded here. Pin the
    // per-row fields listCatalog() attaches — the ones the fixture above stands
    // in for — so renaming one fails here instead of silently labelling every
    // plugin "Available" and emptying the installed / update-available filters.
    const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'plugin-manager.ts'), 'utf8');
    // extractFunction() cannot be used here: listCatalog carries a TypeScript
    // return type, so the first brace after its signature belongs to the type,
    // not the body. Slice the top-level function out by its closing brace.
    const start = main.indexOf('function listCatalog(');
    assert.ok(start !== -1, 'listCatalog should exist in plugin-manager.ts');
    const listCatalogSource = main.slice(start, main.indexOf('\n}\n', start));
    for (const field of ['installedVersion', 'bundled', 'activeSource', 'canRollback', 'compat']) {
        assert.ok(listCatalogSource.includes(field), `listCatalog should attach '${field}' to every row`);
    }
    // The error state depends on the handler being able to report a failure at
    // all, rather than answering a bare empty array.
    assert.match(listCatalogSource, /ok: false/);
    assert.match(listCatalogSource, /ok: true/);
});

test('listCatalog attaches the lifecycle view so the install list keeps its controls', () => {
    // Catalog UI 1/5 dropped the lifecycle fields (installed, pinned, disabled,
    // updateStatus, updateAvailable, downgradeVersions) from the row while
    // reworking the payload shape, which left every update/pin/disable control
    // in the install list dead — the checkboxes were the only part still
    // working. Pin the attach again, alongside the compat verdict.
    const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'plugin-manager.ts'), 'utf8');
    const start = main.indexOf('function listCatalog(');
    assert.ok(start !== -1, 'listCatalog should exist in plugin-manager.ts');
    const listCatalogSource = main.slice(start, main.indexOf('\n}\n', start));
    assert.match(listCatalogSource, /lifecycleView\(/, 'the view is built from the record');
    for (const field of ['installedVersion', 'bundled', 'activeSource', 'canRollback', 'compat']) {
        assert.ok(listCatalogSource.includes(field), `listCatalog should still attach '${field}' to every row`);
    }
});

test('the install action gates incompatible entries in main, with the reason, before downloading', () => {
    // The cards ask compatibilityFor(); the install path must ask the same
    // single question, so a plugin the backend cannot load is refused with the
    // same words the card showed — not downloaded first and failed later.
    const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'plugin-manager.ts'), 'utf8');
    const start = main.indexOf('function refuseIncompatible(');
    assert.ok(start !== -1, 'installFromCatalog should split off entries this build cannot run');
    const gate = main.slice(start, main.indexOf('\n}', start));
    assert.match(gate, /compatibilityFor\(/, 'the same rule the cards use');
    assert.match(gate, /verdict\.reason/, 'the refusal carries the actionable reason');
    const installStart = main.indexOf('export async function installFromCatalog(');
    const install = main.slice(installStart, main.indexOf('\n}', installStart));
    assert.match(install, /refuseIncompatible\(/, 'the batch only receives what fits');
    assert.match(install, /networkRequired/, 'connect-only failures are reported as such');
});

// ── Card badges ──────────────────────────────────────────────────────

function labels(entry) {
    return view.pmCatalogBadges(entry).map((badge) => badge.label);
}

test('badges distinguish the three sources the backend can load', () => {
    // The activeSource of src/main/plugin-precedence.ts, made visible: which
    // copy is on disk decides which badge the card wears, not just install
    // state. Each badge explains itself, because "writable override" means
    // nothing without the precedence rule.
    assert.deepEqual(labels(entry({ activeSource: 'bundled', bundled: true })), ['Bundled']);
    assert.deepEqual(labels(entry({ activeSource: 'installed', installedVersion: '1.0.0' })), ['Installed']);
    assert.deepEqual(
        labels(entry({ activeSource: 'writable-override', installedVersion: '1.0.0' })),
        ['Writable override']
    );
    for (const badge of view.pmCatalogBadges(entry({ activeSource: 'writable-override', installedVersion: '1.0.0' }))) {
        assert.ok(badge.title, 'every source badge explains what its source means');
    }
    assert.equal(
        view.pmCatalogBadges(entry({ activeSource: 'writable-override' }))[0].title,
        'Your copy shadows a packaged plugin with the same id, so the backend loads yours.'
    );
});

test('state badges cover available and update-available; installed needs no second badge', () => {
    assert.deepEqual(labels(entry()), ['Available']);
    assert.deepEqual(labels(entry({ installedVersion: '0.9.0' })), ['Update available']);
    // The installed copy already carries the "Installed" source badge — a
    // second one would just repeat it.
    assert.deepEqual(labels(entry({ activeSource: 'installed', installedVersion: '1.0.0' })), ['Installed']);
    assert.deepEqual(labels(entry({ bundled: true, activeSource: 'bundled' })), ['Bundled']);
});

test('a source badge claiming presence suppresses the contradictory "Available" badge', () => {
    // activeSource reports 'bundled' for any packaged copy, including one whose
    // manifest does not claim bundled: true (docs/PLUGIN_CATALOG.md), and a
    // git-installed copy need not carry a version — so pmCatalogState can say
    // "available" for a plugin that is very much on disk. One card must not
    // wear two badges that disagree about that.
    assert.deepEqual(
        labels(entry({ bundled: false, activeSource: 'bundled' })),
        ['Bundled']
    );
    assert.deepEqual(
        labels(entry({ activeSource: 'installed', installedVersion: null })),
        ['Installed']
    );
    // Nothing on disk still earns "Available": no source badge claims it.
    assert.deepEqual(labels(entry({ activeSource: 'none', installedVersion: null })), ['Available']);
});

test('an incompatible entry is badged first, before any status or tier', () => {
    const incompatible = entry({
        activeSource: 'writable-override',
        installedVersion: '0.9.0',
        selection: { tier: 'recommended', defaultSelected: true },
        compat: {
            ok: false,
            requirements: 'fee[dB]ack core 0.4.0 or newer',
            reason: 'Example needs fee[dB]ack core 0.4.0 or newer; this build ships 0.3.0.',
        },
    });
    assert.deepEqual(labels(incompatible), [
        'Incompatible', 'Writable override', 'Update available', 'Recommended',
    ]);
});

test('tier badges separate a recommendation from an essential, non-optional plugin', () => {
    // The colour pairing is the point: a recommendation must never wear the
    // sky colour reserved for "ships with the app / locked into every plan".
    const essential = view.pmCatalogBadges(entry({ selection: { tier: 'essential', defaultSelected: true } }));
    const recommended = view.pmCatalogBadges(entry({ selection: { tier: 'recommended', defaultSelected: true } }));
    assert.deepEqual(essential.map((badge) => badge.label), ['Available', 'Essential']);
    assert.deepEqual(recommended.map((badge) => badge.label), ['Available', 'Recommended']);
    assert.equal(essential[1].cls, 'bg-sky-900/40 text-sky-300');
    assert.equal(recommended[1].cls, 'bg-indigo-900/40 text-indigo-300');
    assert.notEqual(essential[1].cls, recommended[1].cls);
    // An optional plugin claims neither.
    assert.deepEqual(labels(entry()), ['Available']);
});

// ── The rendered card ────────────────────────────────────────────────

// Whole-screen stub, the same shape tests/renderer-html-escaping.test.js uses
// for this script: elements auto-create on getElementById and innerHTML is a
// plain string, so the assertions read exactly what the screen handed the DOM.
function makeElement(tag = 'div') {
    const el = {
        tagName: String(tag).toUpperCase(),
        className: '',
        textContent: '',
        id: '',
        type: '',
        value: '',
        disabled: false,
        checked: false,
        dataset: {},
        children: [],
        handlers: {},
        style: {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        appendChild(child) { el.children.push(child); return child; },
        addEventListener(type, fn) { (el.handlers[type] = el.handlers[type] || []).push(fn); },
    };
    let html = '';
    Object.defineProperty(el, 'innerHTML', {
        get() { return html; },
        set(value) { html = String(value); el.children.length = 0; },
    });
    el.querySelectorAll = (selector) => descendants(el).filter((node) => matchesClass(node, selector));
    el.querySelector = (selector) => el.querySelectorAll(selector)[0] || null;
    return el;
}

function descendants(el, found = []) {
    for (const child of el.children) {
        found.push(child);
        descendants(child, found);
    }
    return found;
}

// Only the `.class` selector form this screen uses.
function matchesClass(node, selector) {
    if (!selector.startsWith('.')) throw new Error(`stub query does not handle '${selector}'`);
    return String(node.className).split(/\s+/).includes(selector.slice(1));
}

function makeDocument() {
    const byId = new Map();
    return {
        getElementById(id) {
            if (!byId.has(id)) byId.set(id, makeElement());
            return byId.get(id);
        },
        createElement: (tag) => makeElement(tag),
    };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

// Load the whole screen with the given catalog rows. `plan` is what the
// install list's plugins.resolveCatalog answers; every other bridge call the
// screen makes at load is stubbed so a render that reaches for one does not
// throw. The resolved calls are counted — one per render is the point of the
// test at the bottom of this file.
async function runScreen(entries, { plan, ...extra } = {}) {
    const document = makeDocument();
    const resolveCalls = [];
    const plugins = {
        listInstalled: () => Promise.resolve([]),
        catalog: () => Promise.resolve({ ok: true, entries }),
        remove: async () => ({ success: true, message: 'Removed.' }),
        update: async () => ({ success: true, message: 'Updated.' }),
        resolveCatalog: async (ids) => {
            resolveCalls.push([...ids]);
            if (plan) return typeof plan === 'function' ? plan(ids) : plan;
            return { ids, outstanding: ids, required: {}, conflicts: [] };
        },
        ...extra,
    };
    const sandbox = {
        window: { feedBackDesktop: { plugins } },
        document,
        setTimeout: () => 0,
        clearTimeout: () => {},
        confirm: () => true,
        globalThis: undefined,
    };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(SCREEN_JS, sandbox, { filename: 'plugin-manager/screen.js' });
    await flush();
    await flush();
    return { document, resolveCalls };
}

// Browse list's HTML once both startup loads (installed list and catalog) have
// drained. Two flushes mirror the sibling suite: the second catches the chain
// that awaits the first.
async function renderedCatalog(entries) {
    const { document } = await runScreen(entries);
    return document.getElementById('pm-catalog-list').innerHTML;
}

test('a card shows name, version, description and the catalog facts from issue #16', async () => {
    const html = await renderedCatalog([entry()]);
    assert.ok(html.includes('Example'), 'name');
    assert.ok(html.includes('v1.0.0'), 'version');
    assert.ok(html.includes('An example plugin.'), 'description');
    // category · instruments · source · stability · download size, as one line.
    assert.ok(html.includes('practice · guitar · get-flashbacks · Stable · 1 KB download'), `meta line, got:\n${html}`);
});

test('a fitting card states the requirements of this build', async () => {
    const html = await renderedCatalog([entry()]);
    assert.ok(
        html.includes('Requires fee[dB]ack core 0.3.0 or newer, plugin API 1 or newer'),
        `requirements line, got:\n${html}`
    );
    assert.ok(!html.includes('Incompatible'), 'a fitting entry is not badged as incompatible');
});

test('an incompatible card leads with the badge and the reason, not just a mark', async () => {
    const html = await renderedCatalog([entry({
        name: 'Future Thing',
        compat: {
            ok: false,
            requirements: 'fee[dB]ack core 0.4.0 or newer',
            reason: 'Future Thing needs fee[dB]ack core 0.4.0 or newer; this build ships 0.3.0.',
        },
    })]);
    assert.ok(html.includes('Incompatible'), 'the badge');
    assert.ok(
        html.includes('Future Thing needs fee[dB]ack core 0.4.0 or newer; this build ships 0.3.0.'),
        `the reason, got:\n${html}`
    );
    // The failure replaces the requirements line — the card does not claim the
    // plugin fits while explaining that it does not.
    assert.ok(!html.includes('Requires fee[dB]ack'), `no requirements line, got:\n${html}`);
});

test('cards distinguish bundled, installed and writable-override copies', async () => {
    const html = await renderedCatalog([
        entry({ id: 'bundled-one', name: 'Bundled One', bundled: true, activeSource: 'bundled' }),
        entry({ id: 'installed-one', name: 'Installed One', installedVersion: '1.0.0', activeSource: 'installed' }),
        entry({ id: 'override-one', name: 'Override One', installedVersion: '1.0.0', activeSource: 'writable-override' }),
    ]);
    assert.ok(html.includes('Bundled'), 'the bundled card wears the bundled badge');
    assert.ok(html.includes('Installed'), 'the installed card wears the installed badge');
    assert.ok(html.includes('Writable override'), 'the override card wears the override badge');
    assert.ok(html.includes('title="Your copy shadows a packaged plugin with the same id'), 'and explains precedence');
});

test('a card separates hard requirements from recommendations', async () => {
    const html = await renderedCatalog([
        entry({
            name: 'Dependent',
            dependencies: ['chords-core'],
            selection: { tier: 'recommended', defaultSelected: true },
        }),
        entry({
            id: 'essential-one',
            name: 'Essential One',
            selection: { tier: 'essential', defaultSelected: true },
        }),
    ]);
    // Declared dependencies are installed whether or not anything recommends
    // the plugin, so they get their own explicit line.
    assert.ok(html.includes('Requires: chords-core'), `dependency line, got:\n${html}`);
    assert.ok(html.includes('Recommended'), 'the tier badge');
    assert.ok(html.includes('Essential'), 'the non-optional tier badge');
    // The recommendation is a badge, the dependency is a line: two different
    // affordances, so "Recommended" cannot read as "required".
    assert.ok(!html.includes('Requires: Recommended'), 'a tier is never phrased as a requirement');
});

test('every catalog field on a card arrives escaped, never as markup', async () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const html = await renderedCatalog([entry({
        name: hostile,
        description: '<b>desc</b>',
        compat: {
            ok: false,
            requirements: '',
            reason: `${hostile} & <script>`,
        },
    })]);
    assert.ok(!html.includes('<img'), `no raw tag, got:\n${html}`);
    assert.ok(!html.includes('<script>'), 'the reason is escaped too');
    assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'), 'escaped, not dropped');
    assert.ok(html.includes('&lt;b&gt;desc&lt;/b&gt;'), 'description escaped, not dropped');
});

// ── The install list (issue #17, catalog UI 3/5) ─────────────────────────

test('the install list reads the same { ok, entries } payload the browse list does', async () => {
    const { document } = await runScreen([
        entry({ id: 'alpha', name: 'Practice Alpha' }),
        entry({ id: 'beta', name: 'Practice Beta' }),
    ]);
    const list = document.getElementById('pm-catalog');
    assert.equal(list.children.length, 2, 'a checkbox row per catalog entry, not the empty-list message');
    assert.equal(list.children[0].children[0].type, 'checkbox');
    assert.equal(list.children[0].children[0].handlers.change.length, 1, 'one change handler per row');
    // Both lists are fed the same one payload, so neither can be starved.
    const browse = document.getElementById('pm-catalog-list').innerHTML;
    assert.ok(browse.includes('Practice Alpha'), `browse cards render too, got:\n${browse}`);
});

test('checking a box resolves the selection in main and explains the dependencies it pulls in', async () => {
    const { document, resolveCalls } = await runScreen(
        [entry({ id: 'alpha', name: 'Practice Alpha', dependencies: ['core'] }), entry({ id: 'core', name: 'Core' })],
        {
            plan: {
                ids: ['alpha', 'core'],
                outstanding: ['alpha', 'core'],
                required: { alpha: ['core'] },
                conflicts: [],
            },
        }
    );
    const list = document.getElementById('pm-catalog');
    const box = list.children[0].children[0];
    box.checked = true;
    await box.handlers.change[0]();

    assert.deepEqual(resolveCalls, [['alpha']], 'the resolver is asked about the selection the user just made');
    assert.equal(
        document.getElementById('pm-catalog-deps').textContent,
        'Install set (2): Practice Alpha, Core.\n'
        + 'Required by the selection: Core (required by Practice Alpha).\n'
        + '2 downloads. Installing requires a network connection; the catalog itself stays available offline.',
        'the whole resolved set is visible before the install is confirmed, with the request named'
    );
    // The resolver's answer is reflected on the rows: the dependency the user
    // never ticked is adopted into the plan and locked — unticking must not be
    // a silent detour around the resolution.
    const coreBox = list.children[1].children[0];
    assert.equal(coreBox.checked, true, 'the auto-added dependency is ticked');
    assert.equal(coreBox.disabled, true, 'and locked while something selected needs it');
    const installBtn = document.getElementById('pm-catalog-install');
    assert.equal(installBtn.textContent, 'Install selected (2)', 'the button counts the resolved set, not the raw ticks');
});

test('a selection the resolver pruned is reported before anything is downloaded', async () => {
    const { document } = await runScreen(
        [entry({ id: 'alpha', name: 'Practice Alpha' }), entry({ id: 'beta', name: 'Practice Beta' }), entry({ id: 'gamma', name: 'Tools Gamma' })],
        {
            plan: {
                ids: ['alpha'],
                outstanding: ['alpha'],
                required: {},
                // A kept/dropped pair is a clash; no keeper is the cascade
                // that followed some other drop.
                conflicts: [
                    { kept: 'alpha', dropped: 'beta' },
                    { kept: null, dropped: 'gamma' },
                ],
            },
        }
    );
    const list = document.getElementById('pm-catalog');
    const box = list.children[0].children[0];
    box.checked = true;
    await box.handlers.change[0]();

    assert.equal(
        document.getElementById('pm-catalog-deps').textContent,
        'Install set (1): Practice Alpha.\n'
        + 'Will not install: Practice Beta conflicts with Practice Alpha; Tools Gamma depends on something that was dropped.\n'
        + '1 download. Installing requires a network connection; the catalog itself stays available offline.'
    );
    // A dropped entry's box is unticked to match: a ticked checkbox that the
    // plan refuses would read as installed.
    assert.equal(list.children[1].children[0].checked, false, 'the pruned clash is unticked');
    assert.equal(list.children[2].children[0].checked, false, 'the pruned cascade is unticked');
});

test('a re-render resolves the selection once, not once per row', async () => {
    const { document, resolveCalls } = await runScreen(
        [
            entry({ id: 'alpha', name: 'Practice Alpha', canRollback: true }),
            entry({ id: 'beta', name: 'Practice Beta' }),
            entry({ id: 'gamma', name: 'Tools Gamma' }),
        ],
        { rollbackCatalog: async () => ({ success: true, message: 'Restored.' }) }
    );

    const list = document.getElementById('pm-catalog');
    assert.equal(list.children.length, 3, 'three rows to build');
    const box = list.children[0].children[0];
    box.checked = true;
    await box.handlers.change[0]();
    assert.equal(resolveCalls.length, 1, 'one resolve for the change');

    // Restoring a previous version rebuilds the list; the selection is still
    // set, so the rebuild has to refresh the note — once, not once per row.
    const restore = list.children[0].children.find((child) => child.textContent === 'Restore previous');
    assert.ok(restore, 'the rollback control is offered');
    await restore.handlers.click[0]({ preventDefault() {}, stopPropagation() {} });
    await flush();
    await flush();

    assert.equal(resolveCalls.length, 2, `one resolve for the whole rebuild, got ${resolveCalls.length}`);
});

// ── The install action (issue #18, catalog UI 4/5) ───────────────────────
//
// One install action through the main-process API, with offline and error
// states. The screen stub's plugins.installCatalog answers with the same shape
// the plugins:installCatalog handler answers with; what is pinned here is how
// the UI behaves on each answer — the states themselves, not the filesystem.

// Tick a row, wait for the resolver pass it triggers, then run the single
// install action the section wires, and drain the re-render it ends with.
async function selectAndInstall(entries, extra) {
    const screen = await runScreen(entries, extra);
    const list = screen.document.getElementById('pm-catalog');
    const box = list.children[0].children[0];
    box.checked = true;
    await box.handlers.change[0]();
    const installBtn = screen.document.getElementById('pm-catalog-install');
    await installBtn.handlers.click[0]();
    await flush();
    await flush();
    return { ...screen, list, box };
}

test('an entry that does not fit this build cannot be ticked and says why, like its card', async () => {
    const { document } = await runScreen([entry({
        name: 'Future Thing',
        compat: {
            ok: false,
            requirements: 'fee[dB]ack core 0.4.0 or newer',
            reason: 'Future Thing needs fee[dB]ack core 0.4.0 or newer; this build ships 0.3.0.',
        },
    })]);
    const list = document.getElementById('pm-catalog');
    const box = list.children[0].children[0];
    assert.equal(box.disabled, true, 'the checkbox is included with the selection controls, but off');
    assert.equal(
        box.checked, false,
        'an incompatibility is not a waiting state: the plugin cannot be installed here at all'
    );
    assert.ok(
        list.children[0].children[1].innerHTML.includes('Future Thing needs fee[dB]ack core 0.4.0 or newer; this build ships 0.3.0.'),
        `the actionable reason is on the row itself, got:\n${list.children[0].children[1].innerHTML}`
    );
});

test('an offline install reports that a connection is required and keeps the selection for retry', async () => {
    const { document, list, box } = await selectAndInstall(
        [entry({ id: 'alpha', name: 'Practice Alpha' })],
        {
            // ids is an array from the screen's realm; reach through it instead
            // of strict-deep-equality against this realm's Array.prototype.
            installCatalog: async (ids) => {
                assert.deepEqual([...ids], ['alpha'], 'the action sends the ticked selection; main resolves it');
                return {
                    success: false,
                    networkRequired: true,
                    message: '0 of 1 plugin installed.',
                    results: [{
                        id: 'alpha',
                        name: 'Practice Alpha',
                        success: false,
                        message: 'Could not download Practice Alpha. Check your internet connection and try again.',
                        networkRequired: true,
                    }],
                };
            },
            onInstallProgress: () => () => {},
        }
    );
    const msg = document.getElementById('pm-catalog-msg');
    assert.match(msg.textContent, /network connection is required/, `said up front, got:\n${msg.textContent}`);
    assert.match(msg.textContent, /Practice Alpha: Could not download Practice Alpha/, 'the plugin’s own report stays');
    assert.equal(box.checked, true, 'the tick survives the failed run so retrying is one click');
    assert.equal(document.getElementById('pm-catalog-install').textContent, 'Install selected (1)');
});

test('a mixed install keeps what failed ticked, prunes what landed, and reports every plugin', async () => {
    const { document } = await runScreen(
        [
            entry({ id: 'alpha', name: 'Practice Alpha' }),
            entry({ id: 'beta', name: 'Practice Beta' }),
        ],
        {
            installCatalog: async (ids) => {
                assert.deepEqual([...ids].sort(), ['alpha', 'beta']);
                return {
                    success: false,
                    message: '1 of 2 plugins installed.',
                    results: [
                        { id: 'alpha', name: 'Practice Alpha', success: true, message: 'Installed Practice Alpha 1.0.0.' },
                        { id: 'beta', name: 'Practice Beta', success: false, message: 'Practice Beta conflicts with Practice Alpha. Install only one of them.' },
                    ],
                };
            },
            onInstallProgress: () => () => {},
        }
    );
    const list = document.getElementById('pm-catalog');
    for (const child of list.children) {
        child.children[0].checked = true;
        await child.children[0].handlers.change[0]();
    }
    await document.getElementById('pm-catalog-install').handlers.click[0]();
    await flush();
    await flush();

    const msg = document.getElementById('pm-catalog-msg');
    assert.match(msg.textContent, /1 of 2 plugins installed/, 'the running tally leads');
    assert.match(msg.textContent, /Practice Beta: Practice Beta conflicts with Practice Alpha/, 'each failure is named');

    assert.equal(list.children[0].children[0].checked, false, 'what landed is pruned from the set…');
    assert.equal(list.children[1].children[0].checked, true, '…what failed stays ticked for the retry');
});

test('a successful install clears the selection and closes the plan note', async () => {
    const { document, list } = await selectAndInstall(
        [entry({ id: 'alpha', name: 'Practice Alpha' })],
        {
            installCatalog: async () => ({
                success: true,
                message: 'Installed 1 plugin.',
                results: [{ id: 'alpha', name: 'Practice Alpha', success: true, message: 'Installed Practice Alpha 1.0.0.' }],
            }),
            onInstallProgress: () => () => {},
        }
    );
    const msg = document.getElementById('pm-catalog-msg');
    assert.match(msg.textContent, /Installed 1 plugin/);
    assert.equal(list.children[0].children[0].checked, false, 'nothing is left ticked');
    assert.equal(document.getElementById('pm-catalog-install').textContent, 'Install selected', 'the button resets');
    assert.ok(
        document.getElementById('pm-catalog-deps').textContent === '',
        'the plan note is gone — nothing is queued any more'
    );
});

test('the resolved plan is priced before confirmation: transfer size and the network it needs', async () => {
    const { document } = await runScreen(
        [entry({ id: 'alpha', name: 'Practice Alpha' }), entry({ id: 'core', name: 'Core' })],
        {
            plan: {
                ids: ['alpha', 'core'],
                outstanding: ['alpha', 'core'],
                required: {},
                conflicts: [],
                downloadBytes: 476729,
            },
        }
    );
    const box = document.getElementById('pm-catalog').children[0].children[0];
    box.checked = true;
    await box.handlers.change[0]();;

    const note = document.getElementById('pm-catalog-deps').textContent;
    assert.match(note, /2 downloads \(~466 KB\)/, `the pinned size, got:\n${note}`);
    assert.match(note, /Installing requires a network connection/, 'said before the click, not only after a failure');
});

test('the screen never writes plugin files itself — every action goes through the main-process bridge', () => {
    // The renderer runs with nodeIntegration: false and contextIsolation: true,
    // so it could not touch the disk even if it tried; these assertions keep it
    // that way by construction. Every plugin operation — install included —
    // must be an IPC-shaped call on window.feedBackDesktop.plugins, and the
    // method name must be one main's preload actually exposes.
    for (const pattern of [
        /\brequire\s*\(/,
        /\bmodule\.\b/,
        /\bipcRenderer\b/,
        /\bchild_process\b/,
        /\bfs\.\w+\(/,
        /\bprocess\.(?:exit|env|cwd)\b/,
    ]) {
        assert.ok(!pattern.test(SCREEN_JS), `screen.js must not reference ${pattern}`);
    }

    const preload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.ts'), 'utf8');
    const start = preload.indexOf('plugins: {');
    assert.ok(start !== -1, 'the preload exposes a plugins bridge');
    const block = preload.slice(start, preload.indexOf('\n    },', start));
    const bridged = new Set([...block.matchAll(/^\s{8}(\w+):/gm)].map((m) => m[1]));

    const called = [...new Set([...SCREEN_JS.matchAll(/plugins\.([A-Za-z_$][\w$]*)\(/g)].map((m) => m[1]))];
    assert.ok(called.includes('installCatalog'), 'the install action is part of the audited surface');
    for (const name of called) {
        assert.ok(bridged.has(name), `plugins.${name} must be a method the preload bridge defines`);
    }
    assert.ok(bridged.has('installCatalog') && bridged.has('resolveCatalog'),
        'the bridge exposes the catalog install and resolution the screen wires');
});