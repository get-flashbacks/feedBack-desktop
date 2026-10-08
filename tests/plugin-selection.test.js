'use strict';

// Guided plugin selection (issue #5): the wizard's question list, its
// data-driven recommendations, and the resolved install plan (dependency
// closure, conflict pruning, sizes). Pure logic, so no Electron needed.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { loadTs, ROOT } = require('./_load-ts');

const selection = loadTs('src/main/plugin-selection.ts');
const { PLUGIN_API_VERSION, compatibilityFor } = loadTs('src/main/plugin-compat.ts');

// The verdict plugins:catalog attaches to a row (the selection layer ignores
// it; the row carries it), computed by the real rule so this fixture cannot
// drift from what src/main/plugin-compat.ts actually produces.
const CATALOG_ROW_COMPAT = compatibilityFor(
    { name: 'ROW', compatibility: { minCoreVersion: '0.3.0', minPluginApiVersion: '1' } },
    {
        coreVersion: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
        pluginApiVersion: PLUGIN_API_VERSION,
    }
);

/** Build a catalog row the way `plugins:catalog` projects it. */
function row(id, overrides = {}) {
    return {
        id,
        installDir: id,
        name: overrides.name ?? id.toUpperCase(),
        description: overrides.description ?? `${id} plugin`,
        repository: `https://github.com/get-flashbacks/feedBack-plugin-${id}`,
        version: overrides.version ?? '1.0.0',
        commit: 'c'.repeat(40),
        archiveSha256: 'd'.repeat(64),
        source: 'get-flashbacks',
        category: overrides.category ?? 'tools',
        instruments: overrides.instruments ?? [],
        stability: 'stable',
        compatibility: { minCoreVersion: '0.3.0', minPluginApiVersion: '1' },
        compat: { ...CATALOG_ROW_COMPAT },
        dependencies: overrides.dependencies ?? [],
        conflicts: overrides.conflicts ?? [],
        size: {
            downloadBytes: overrides.downloadBytes ?? 1000,
            installedBytes: overrides.installedBytes ?? 2000,
        },
        selection: {
            tier: overrides.tier ?? 'recommended',
            defaultSelected: overrides.defaultSelected === true,
        },
        ...(overrides.installedVersion ? { installedVersion: overrides.installedVersion } : {}),
        ...(overrides.bundled ? { bundled: true } : {}),
        ...(overrides.blocked ? { blocked: true } : {}),
        ...(overrides.activeSource ? { activeSource: overrides.activeSource } : {}),
    };
}

function entries(rows) {
    return selection.toSelectionEntries(rows);
}

// ── Normalization ─────────────────────────────────────────────────────────

test('damaged catalog rows are dropped instead of partially trusted', () => {
    const parsed = entries([
        row('good'),
        { id: 'bad id' },
        null,
        { name: 'no id' },
        row('dupe', { name: 'first' }),
        row('dupe', { name: 'second' }),
    ]);
    assert.deepStrictEqual(parsed.map(e => e.id), ['good', 'dupe']);
    assert.strictEqual(parsed[1].name, 'first');
    // A row missing optional metadata still yields a usable entry.
    const sparse = selection.toSelectionEntry({ id: 'sparse', name: 'Sparse' });
    assert.strictEqual(sparse.tier, 'optional');
    assert.strictEqual(sparse.instruments.length, 0);
    assert.strictEqual(sparse.downloadBytes, 0);
    assert.strictEqual(sparse.installedVersion, null);
});

test('the bundled catalog loads and every entry is selectable', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'resources/plugin-catalog.json'), 'utf8'));
    const parsed = entries(raw.entries);
    assert.ok(parsed.length >= 1);
    for (const entry of parsed) {
        assert.notStrictEqual(entry.tier, 'hidden');
        assert.ok(entry.description.length > 0, `${entry.id} needs a description`);
        assert.ok(entry.version.length > 0);
    }
});

// ── Questions ─────────────────────────────────────────────────────────────

test('questions are derived from the catalog metadata, not hardcoded', () => {
    const questions = selection.buildWizardQuestions(entries([
        row('guitar_thing', { instruments: ['guitar', 'bass'], category: 'practice' }),
        row('vocal_thing', { instruments: ['vocals'], category: 'visualization' }),
        row('anything', { instruments: [], category: 'tools' }),
        // A hidden entry's tags must not create questions — it is never offered.
        row('internal', { instruments: ['theremin'], category: 'internal', tier: 'hidden' }),
    ]));
    assert.deepStrictEqual(
        questions.instruments.map(o => o.id),
        ['bass', 'guitar', 'vocals'],
    );
    assert.deepStrictEqual(
        questions.categories.map(o => o.id),
        ['practice', 'tools', 'visualization'],
    );
    assert.deepStrictEqual(questions.instruments.map(o => o.label), ['Bass', 'Guitar', 'Vocals']);
    assert.deepStrictEqual(questions.categories.map(o => o.label), ['Practice', 'Tools', 'Visualization']);
});

test('an unseen answer is ignored rather than trusted', () => {
    const parsed = entries([row('a', { instruments: ['guitar'], category: 'practice' })]);
    const preview = selection.previewSelection(parsed, {
        instruments: ['guitar', 'theremin', 42],
        categories: ['practice', 'nope'],
    });
    assert.deepStrictEqual(preview.recommended, ['a']);
    assert.deepStrictEqual(preview.questions.instruments.map(o => o.id), ['guitar']);
});

// ── Recommendations ───────────────────────────────────────────────────────

const CATALOG = entries([
    row('difficulty', { instruments: ['guitar', 'bass', 'keys'], category: 'practice' }),
    row('importer', { instruments: ['guitar', 'bass', 'keys'], category: 'tools' }),
    row('metronome', { instruments: [], category: 'practice' }),
    row('lyrics', { instruments: ['vocals'], category: 'visualization' }),
    row('piano', { instruments: ['keys'], category: 'visualization' }),
    row('always', { tier: 'optional', defaultSelected: true }),
    row('core', { tier: 'essential', instruments: [], category: 'tools' }),
    row('secret', { tier: 'hidden' }),
]);

function recommend(answers) {
    return selection.recommendIds(CATALOG, answers).sort();
}

test('a chosen instrument recommends its plugins plus the instrument-agnostic ones', () => {
    assert.deepStrictEqual(recommend({ instruments: ['guitar'], categories: [] }), [
        'always', 'core', 'difficulty', 'importer', 'metronome',
    ]);
});

test('a different instrument gets a different set', () => {
    assert.deepStrictEqual(recommend({ instruments: ['vocals'], categories: [] }), [
        'always', 'core', 'lyrics', 'metronome',
    ]);
});

test('essentials and catalog defaults are recommended regardless of answers', () => {
    assert.deepStrictEqual(recommend({ instruments: [], categories: [] }), ['always', 'core']);
});

test('a blocked entry is never offered, asked about or recommended', () => {
    const list = entries([
        row('ok', { instruments: ['guitar'], category: 'practice' }),
        row('gone', { blocked: true, tier: 'essential', instruments: ['banjo'], category: 'percussion' }),
        row('unsafe', { blocked: true, defaultSelected: true }),
    ]);
    // It stays a catalog entry: a request for it must be answered by name, so
    // the install gate can refuse it with the block reason instead of it
    // silently disappearing from the plan.
    assert.deepStrictEqual(list.map(e => e.id), ['ok', 'gone', 'unsafe']);
    assert.deepStrictEqual(selection.selectableEntries(list).map(e => e.id), ['ok']);
    // Neither the essential tier nor the default flag gets past the block.
    assert.deepStrictEqual(selection.recommendIds(list, { instruments: [], categories: [] }), []);
    // The question list is built from the offered set, so a blocked entry's
    // tags never shape it either.
    const questions = selection.buildWizardQuestions(list);
    assert.deepStrictEqual(questions.instruments.map(o => o.id), ['guitar']);
    assert.deepStrictEqual(questions.categories.map(o => o.id), ['practice']);
    assert.deepStrictEqual(selection.resolveSelection(list, ['gone']).ids, ['gone']);
});

test('chosen categories recommend their plugins on top of the instrument match', () => {
    // 'metronome' is instrument-agnostic, so it still comes along with 'vocals'.
    assert.deepStrictEqual(
        recommend({ instruments: ['vocals'], categories: ['visualization'] }),
        ['always', 'core', 'lyrics', 'metronome', 'piano'],
    );
});

test('hidden entries are never recommended but are offered once selected', () => {
    assert.ok(!recommend({ instruments: ['guitar'], categories: ['practice'] }).includes('secret'));
    const plan = selection.resolveSelection(CATALOG, ['secret']);
    assert.deepStrictEqual(plan.ids, ['secret']);
    assert.deepStrictEqual(selection.selectableEntries(CATALOG).map(e => e.id).includes('secret'), false);
});

// ── Resolution ────────────────────────────────────────────────────────────

test('dependencies are added automatically and ordered before their dependents', () => {
    const parsed = entries([
        row('engine', { tier: 'hidden' }),
        row('visualizer', { dependencies: ['engine'] }),
        row('top', { dependencies: ['visualizer', 'engine'] }),
    ]);
    const plan = selection.resolveSelection(parsed, ['top']);
    assert.deepStrictEqual(plan.ids, ['engine', 'visualizer', 'top']);
    assert.deepStrictEqual(plan.required, { top: ['visualizer'], visualizer: ['engine'] });
    assert.deepStrictEqual(plan.optional, ['top']);
    assert.strictEqual(plan.downloadBytes, 3000);
});

test('a dependency the user also picked is not reported as auto-added', () => {
    const parsed = entries([row('engine', { tier: 'hidden' }), row('visualizer', { dependencies: ['engine'] })]);
    const plan = selection.resolveSelection(parsed, ['engine', 'visualizer']);
    assert.deepStrictEqual(plan.ids, ['engine', 'visualizer']);
    assert.deepStrictEqual(plan.required, {});
});

test('the plan size counts only what the batch will actually fetch', () => {
    const parsed = entries([
        row('already', { installedVersion: '1.0.0' }),
        row('bundled', { bundled: true }),
        row('fresh', { downloadBytes: 700 }),
        // A different installed version is an upgrade, not a reinstall.
        row('outdated', { version: '2.0.0', installedVersion: '1.0.0', downloadBytes: 500 }),
    ]);
    const plan = selection.resolveSelection(parsed, ['already', 'bundled', 'fresh', 'outdated']);
    // Everything is still in the plan — the two skipped entries are just not
    // part of the transfer, so counting them would strand the wizard's progress
    // bar short of 100% for the whole run.
    assert.deepStrictEqual(plan.ids, ['already', 'bundled', 'fresh', 'outdated']);
    assert.strictEqual(plan.downloadBytes, 1200);
});

test('unknown and duplicate ids are ignored', () => {
    const plan = selection.resolveSelection(entries([row('a')]), ['a', 'a', 'nope', 42, null]);
    assert.deepStrictEqual(plan.ids, ['a']);
});

test('a conflict drops the later choice, not both', () => {
    const parsed = entries([row('old', { conflicts: ['new'] }), row('new')]);
    const plan = selection.resolveSelection(parsed, ['old', 'new']);
    assert.deepStrictEqual(plan.ids, ['old']);
    assert.deepStrictEqual(plan.conflicts, [{ kept: 'old', dropped: 'new' }]);
    // …and the conflict may be declared from the other side too.
    const mirrored = entries([row('new', { conflicts: ['old'] }), row('old')]);
    assert.deepStrictEqual(selection.resolveSelection(mirrored, ['new', 'old']).ids, ['new']);
});

test('a required dependency wins over an optional preference that conflicts with it', () => {
    const parsed = entries([
        row('engine', { tier: 'hidden' }),
        row('visualizer', { dependencies: ['engine'] }),
        row('legacy', { conflicts: ['engine'] }),
    ]);
    const plan = selection.resolveSelection(parsed, ['legacy', 'visualizer']);
    assert.deepStrictEqual(plan.ids, ['engine', 'visualizer']);
    assert.deepStrictEqual(plan.conflicts, [{ kept: 'engine', dropped: 'legacy' }]);
});

test('an essential entry is never the one dropped', () => {
    const parsed = entries([
        row('optional_thing', { conflicts: ['core'] }),
        row('core', { tier: 'essential' }),
    ]);
    const plan = selection.resolveSelection(parsed, ['optional_thing', 'core']);
    assert.deepStrictEqual(plan.ids, ['core']);
    assert.deepStrictEqual(plan.conflicts, [{ kept: 'core', dropped: 'optional_thing' }]);
});

test('an entry whose dependency was dropped is dropped with it', () => {
    const parsed = entries([
        row('core', { tier: 'essential', conflicts: ['legacy_engine'] }),
        row('engine', { tier: 'hidden' }),
        row('legacy_engine', { dependencies: ['engine'] }),
        row('visualizer', { dependencies: ['legacy_engine'] }),
    ]);
    // The essential core wins the conflict, so legacy_engine goes — and the
    // visualizer that needed it goes with it rather than installing broken.
    const plan = selection.resolveSelection(parsed, ['core', 'legacy_engine', 'visualizer']);
    assert.deepStrictEqual(plan.ids, ['engine', 'core']);
    assert.deepStrictEqual(
        plan.conflicts.map(c => c.dropped).sort(),
        ['legacy_engine', 'visualizer'],
    );
    assert.deepStrictEqual(plan.required, {});
});

test('a cyclic dependency graph cannot hang the resolver', () => {
    const parsed = entries([
        row('a', { dependencies: ['b'] }),
        row('b', { dependencies: ['a'] }),
    ]);
    const plan = selection.resolveSelection(parsed, ['a', 'b']);
    // A cycle has no valid topological order — the catalog validator rejects
    // those; the guard here only has to keep the resolver terminating.
    assert.deepStrictEqual([...plan.ids].sort(), ['a', 'b']);
});

// ── Preview (the shape the wizard renders) ────────────────────────────────

test('preview answers the full wizard flow in one call', () => {
    const parsed = entries([
        row('visualizer', { instruments: ['guitar'], dependencies: ['engine'], category: 'visualization' }),
        row('engine', { tier: 'hidden' }),
        row('other', { instruments: ['violin'], category: 'tools' }),
    ]);
    const preview = selection.previewSelection(parsed, { instruments: ['guitar'], categories: [] });
    assert.deepStrictEqual(preview.recommended, ['visualizer']);
    assert.deepStrictEqual(preview.plan.ids, ['engine', 'visualizer']);
    assert.strictEqual(preview.plan.downloadBytes, 2000);
    assert.deepStrictEqual(preview.questions.instruments.map(o => o.id), ['guitar', 'violin']);
});
