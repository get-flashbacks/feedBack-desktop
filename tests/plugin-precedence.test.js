'use strict';

// Bundled baseline vs writable override precedence (issue #22, lifecycle 3/6 of
// #6): the rule that decides, for a plugin id that exists both as a packaged
// core copy and as a writable copy, which single copy the backend loads — and
// the directory scan that classifies copies the way the backend does. Pins the
// four scenarios from the issue (bundled only, override only, both present,
// override removed) plus the readdir-order determinism the scan guarantees.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadTs, ROOT } = require('./_load-ts');

const precedence = loadTs('src/main/plugin-precedence.ts');

function baseline(overrides = {}) {
    return { dir: 'core', version: '1.0.0', bundled: false, ...overrides };
}

function override(overrides = {}) {
    return { dir: 'override', version: '2.0.0', bundled: false, ...overrides };
}

// ── The precedence rule ───────────────────────────────────────────────

test('a bundled-only id is active as the bundled copy', () => {
    assert.equal(precedence.activeSourceFor(baseline({ bundled: true }), null), 'bundled');
});

test('an override-only id is active as an installed copy', () => {
    assert.equal(precedence.activeSourceFor(null, override()), 'installed');
});

test('a bundled baseline wins over a writable override', () => {
    assert.equal(precedence.activeSourceFor(baseline({ bundled: true }), override()), 'bundled');
});

test('a packaged copy that is not a bundled baseline yields to a writable override', () => {
    assert.equal(precedence.activeSourceFor(baseline(), override()), 'writable-override');
});

test('an id with no copy on disk is none', () => {
    assert.equal(precedence.activeSourceFor(null, null), 'none');
});

test('removing the override re-exposes the baseline', () => {
    // The override shadows the packaged copy...
    assert.equal(precedence.activeSourceFor(baseline(), override()), 'writable-override');
    // ...and once removed the packaged copy is active again.
    assert.equal(precedence.activeSourceFor(baseline(), null), 'bundled');
});

test('the rule answers every combination with a single reachable source', () => {
    const packaged = [null, baseline(), baseline({ bundled: true })];
    const writable = [null, override()];
    const reached = new Set();
    for (const packed of packaged) {
        for (const writ of writable) {
            const source = precedence.activeSourceFor(packed, writ);
            assert.ok(['bundled', 'writable-override', 'installed', 'none'].includes(source));
            reached.add(source);
        }
    }
    // Every documented value is reachable, so none is dead documentation.
    assert.deepEqual([...reached].sort(), ['bundled', 'installed', 'none', 'writable-override']);
});

// ── The directory scan ────────────────────────────────────────────────

/** A throwaway plugins root, removed when the test ends. */
function scannedDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'precedence-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function writePlugin(dir, name, manifest) {
    const pluginDir = path.join(dir, name);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify(manifest));
}

test('scanPluginCopies reads id, version and directory name', (t) => {
    const dir = scannedDir(t);
    writePlugin(dir, 'metronome', { id: 'metronome', version: '1.2.0' });
    assert.deepEqual(
        [...precedence.scanPluginCopies(dir).values()],
        [{ dir: 'metronome', version: '1.2.0', bundled: false }],
    );
});

test('a bundled baseline requires both the flag and a matching directory name', (t) => {
    const dir = scannedDir(t);
    writePlugin(dir, 'note_detect', { id: 'note_detect', bundled: true });
    // Same flag, but the directory is not named after the id.
    writePlugin(dir, 'renamed', { id: 'renamed_original', bundled: true });
    // Same id without the flag.
    writePlugin(dir, 'whisper', { id: 'whisper' });
    const copies = precedence.scanPluginCopies(dir);
    assert.equal(copies.get('note_detect').bundled, true);
    assert.equal(copies.get('renamed_original').bundled, false);
    assert.equal(copies.get('whisper').bundled, false);
});

test('dot-prefixed entries and unreadable roots are skipped', (t) => {
    const dir = scannedDir(t);
    writePlugin(dir, '.disabled', { id: 'note_detect' });
    writePlugin(dir, 'metronome', { id: 'metronome' });
    assert.deepEqual([...precedence.scanPluginCopies(dir).keys()], ['metronome']);
    assert.equal(precedence.scanPluginCopies(path.join(dir, 'missing')).size, 0);
});

test('manifests without a string id are ignored', (t) => {
    const dir = scannedDir(t);
    writePlugin(dir, 'good', { id: 'metronome' });
    writePlugin(dir, 'unnamed', { version: '1.0.0' }); // none at all
    writePlugin(dir, 'numbered', { id: 42 }); // not a string
    const copies = precedence.scanPluginCopies(dir);
    assert.deepEqual([...copies.keys()], ['metronome']);
});

test('stray non-directory entries in the root are ignored', (t) => {
    const dir = scannedDir(t);
    writePlugin(dir, 'metronome', { id: 'metronome' });
    fs.writeFileSync(path.join(dir, 'plugin-catalog.json'), '{ "not": "a plugin dir" }');
    assert.deepEqual([...precedence.scanPluginCopies(dir).keys()], ['metronome']);
});

test('two copies of one id resolve to a single deterministic copy', (t) => {
    const dir = scannedDir(t);
    writePlugin(dir, 'aaa', { id: 'metronome', version: '1.0.0' });
    writePlugin(dir, 'zzz', { id: 'metronome', version: '2.0.0' });
    // readdir order is not defined; the sorted first copy is the stable answer.
    const [copy] = precedence.scanPluginCopies(dir).values();
    assert.deepEqual(copy, { dir: 'aaa', version: '1.0.0', bundled: false });
});

test('a bundled baseline outranks a sibling copy of the same id', (t) => {
    const dir = scannedDir(t);
    writePlugin(dir, 'aaa', { id: 'note_detect', version: '1.0.0' });
    writePlugin(dir, 'note_detect', { id: 'note_detect', version: '2.0.0', bundled: true });
    const copy = precedence.scanPluginCopies(dir).get('note_detect');
    assert.deepEqual(copy, { dir: 'note_detect', version: '2.0.0', bundled: true });
});

// ── The scan feeds the rule ───────────────────────────────────────────

test('scanning the same id in both roots yields the two-copy precedence case', (t) => {
    const coreRoot = scannedDir(t);
    const userRoot = scannedDir(t);
    writePlugin(coreRoot, 'metronome', { id: 'metronome', version: '1.0.0', bundled: true });
    writePlugin(userRoot, 'metronome', { id: 'metronome', version: '2.0.0' });

    const core = precedence.scanPluginCopies(coreRoot).get('metronome') ?? null;
    const user = precedence.scanPluginCopies(userRoot).get('metronome') ?? null;
    assert.equal(precedence.activeSourceFor(core, user), 'bundled');
});