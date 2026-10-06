// Read-only catalog view (issue #15). src/renderer/plugin-manager/screen.js
// carries its search and filter semantics in four IIFE-free functions so this
// suite can lift them out by source and pin them without a DOM or a browser:
// pmCatalogState, pmCatalogHaystack, pmCatalogFacets and pmFilterCatalog.
// The view is the only thing tested here — installing is issue #18 (4/5).

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SCREEN_JS = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'plugin-manager', 'screen.js'), 'utf8');
const CATALOG_JSON = path.join(ROOT, 'resources', 'plugin-catalog.json');

// Same brace-matching lift the audio screen suite uses: the function text is
// compiled as-is, so these four must stay free of template literals (their
// braces would confuse the counter) and of any reference to the IIFE scope.
const PURE_FUNCTIONS = ['pmCatalogState', 'pmCatalogHaystack', 'pmCatalogFacets', 'pmFilterCatalog'];

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
        + '\nreturn { pmCatalogState, pmCatalogHaystack, pmCatalogFacets, pmFilterCatalog };\n'
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
        canRollback: false,
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

test('screen.js parses as a whole, not just the four lifted functions', () => {
    // loadView() only compiles the four lifted functions, so everything else in
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
    const rows = raw.entries.map((row) => ({ ...row, installedVersion: null, bundled: false, canRollback: false }));

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
    for (const field of ['installedVersion', 'bundled', 'canRollback']) {
        assert.ok(listCatalogSource.includes(field), `listCatalog should attach '${field}' to every row`);
    }
    // The error state depends on the handler being able to report a failure at
    // all, rather than answering a bare empty array.
    assert.match(listCatalogSource, /ok: false/);
    assert.match(listCatalogSource, /ok: true/);
});