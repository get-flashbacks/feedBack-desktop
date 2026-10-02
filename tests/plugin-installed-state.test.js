'use strict';

// Installed-state record for optional plugins (issue #20, lifecycle 1/6 of #6):
// the versioned on-disk record every later lifecycle operation reads or writes.
// Covers the full field set, the atomic temp-file + rename write, and the
// degradation of a missing / unreadable / corrupt / foreign-schema record.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');

// Compile options come from tsconfig.json so the shim cannot drift from what
// `npm run typecheck` and `npm run build:ts` use.
const tsconfig = ts.readConfigFile(path.join(ROOT, 'tsconfig.json'), ts.sys.readFile);
if (tsconfig.error) throw new Error(ts.flattenDiagnosticMessageText(tsconfig.error.messageText, '\n'));
const { options: compilerOptions } = ts.parseJsonConfigFileContent(tsconfig.config, ts.sys, ROOT);

// Let the record's `import ... from './plugin-installer'` resolve to .ts sources.
require.extensions['.ts'] = function compileTs(module, filename) {
    const source = fs.readFileSync(filename, 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions, fileName: filename });
    module._compile(outputText, filename);
};
const state = require(path.join(ROOT, 'src/main/plugin-installed-state.ts'));
const installer = require(path.join(ROOT, 'src/main/plugin-installer.ts'));

const COMMIT = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);
const CATALOG_REVISION = 'c'.repeat(64);
const INSTALLED_AT = '2026-10-02T20:10:51.000Z';

function catalogEntry(overrides = {}) {
    return {
        id: 'metronome',
        installDir: 'metronome',
        name: 'Metronome',
        repository: 'https://github.com/get-flashbacks/feedBack-plugin-metronome',
        version: '1.2.0',
        commit: COMMIT,
        archiveSha256: DIGEST,
        source: 'get-flashbacks',
        ...overrides,
    };
}

function record(overrides = {}) {
    return state.installedRecordFor(catalogEntry(overrides), CATALOG_REVISION, INSTALLED_AT);
}

function tmpDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'installed-state-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function recordPath(dir) {
    return path.join(dir, state.RECORD_FILE);
}

function tempPath(dir) {
    return `${recordPath(dir)}.tmp`;
}

/** Write a raw body, bypassing the module, to set up a damaged record. */
function putRaw(dir, body) {
    fs.writeFileSync(recordPath(dir), body);
}

// ── Record content ──────────────────────────────────────────────────────────

test('a record carries plugin id, version, repository, commit, hash, install time and catalog revision', () => {
    assert.deepStrictEqual(record(), {
        id: 'metronome',
        installDir: 'metronome',
        version: '1.2.0',
        repository: 'https://github.com/get-flashbacks/feedBack-plugin-metronome',
        commit: COMMIT,
        archiveSha256: DIGEST,
        installedAt: INSTALLED_AT,
        catalogRevision: CATALOG_REVISION,
    });
});

test('a written record round-trips every field through the versioned schema', (t) => {
    const dir = tmpDir(t);
    const other = record({ id: 'feedpakr', installDir: 'feedpakr', version: '0.9.1' });
    state.writeInstalledState(dir, [record(), other], INSTALLED_AT);

    const raw = JSON.parse(fs.readFileSync(recordPath(dir), 'utf8'));
    assert.strictEqual(raw.schemaVersion, state.SCHEMA_VERSION);
    assert.strictEqual(raw.updatedAt, INSTALLED_AT);

    const read = state.readInstalledState(dir);
    assert.strictEqual(read.issue, undefined);
    assert.strictEqual(read.schemaVersion, state.SCHEMA_VERSION);
    assert.strictEqual(read.updatedAt, INSTALLED_AT);
    assert.strictEqual(read.plugins.size, 2);
    for (const expected of [record(), other]) {
        assert.deepStrictEqual(read.plugins.get(expected.id), expected);
    }
});

test('a record is built from a catalog entry only when it is installable', () => {
    // The record mirrors a verified install, so it refuses anything the installer
    // could not have produced (a moving branch instead of a pinned commit).
    assert.throws(() => record({ commit: 'main' }), state.InstalledStateError);
    assert.throws(() => record({ repository: 'https://gitlab.com/get-flashbacks/x' }), state.InstalledStateError);
    assert.throws(() => record({ archiveSha256: 'short' }), state.InstalledStateError);
    assert.throws(() => record({ id: 'Metronome' }), state.InstalledStateError);
});

test('the record validates against the same field patterns as the catalog gate', () => {
    assert.ok(installer.isPluginId('metronome') && !installer.isPluginId('Metronome'));
    assert.ok(installer.isInstallDirName('metronome') && !installer.isInstallDirName('../escape'));
    assert.ok(installer.isCommitSha(COMMIT) && !installer.isCommitSha('main'));
    assert.ok(installer.isArchiveDigest(DIGEST) && !installer.isArchiveDigest('abc'));
    assert.ok(installer.isPluginVersion('1.2.3-beta.1') && !installer.isPluginVersion('1.2'));
    assert.ok(installer.isRepositoryUrl('https://github.com/get-flashbacks/x')
        && !installer.isRepositoryUrl('http://github.com/get-flashbacks/x'));
    assert.deepStrictEqual(installer.repositoryParts('https://github.com/get-flashbacks/x'), { owner: 'get-flashbacks', repo: 'x' });
    assert.strictEqual(installer.repositoryParts('https://github.com/get-flashbacks/x/../../y'), null);
});

// ── Missing / damaged records ───────────────────────────────────────────────

test('no record means bundled baseline only, and reading it cannot throw', (t) => {
    const read = state.readInstalledState(tmpDir(t));
    assert.strictEqual(read.issue, 'missing');
    assert.strictEqual(read.plugins.size, 0);
    assert.strictEqual(read.schemaVersion, 0);
});

test('a corrupt record degrades to bundled baseline only without throwing', (t) => {
    const dir = tmpDir(t);
    const bodies = [
        '',
        'not json at all',
        '{"schemaVersion": 1, "plugins": {',
        JSON.stringify({ plugins: {} }),
        JSON.stringify({ schemaVersion: 1 }),
        JSON.stringify({ schemaVersion: 'one', plugins: {} }),
        JSON.stringify({ schemaVersion: 0, plugins: {} }),
        JSON.stringify({ schemaVersion: 1, plugins: [] }),
    ];
    for (const body of bodies) {
        putRaw(dir, body);
        const read = state.readInstalledState(dir);
        assert.strictEqual(read.issue, 'corrupt', body);
        assert.strictEqual(read.plugins.size, 0, body);
    }
});

test('an unreadable record degrades to bundled baseline only without throwing', (t) => {
    const dir = tmpDir(t);
    fs.mkdirSync(recordPath(dir));
    const read = state.readInstalledState(dir);
    assert.strictEqual(read.issue, 'unreadable');
    assert.strictEqual(read.plugins.size, 0);
});

test('an oversized record is refused before it is parsed', (t) => {
    const dir = tmpDir(t);
    putRaw(dir, `${' '.repeat(600 * 1024)}{}`);
    assert.strictEqual(state.readInstalledState(dir).issue, 'corrupt');
});

test('individual damaged records are dropped, the rest of the record survives', (t) => {
    const dir = tmpDir(t);
    const good = record();
    const damaged = {
        metronome_bad_commit: { ...good, id: 'metronome_bad_commit', commit: 'main' },
        metronome_bad_hash: { ...good, id: 'metronome_bad_hash', archiveSha256: 'nope' },
        metronome_bad_time: { ...good, id: 'metronome_bad_time', installedAt: 'yesterday' },
        // Date.parse accepts these, but they are not timestamps this app writes.
        metronome_loose_date: { ...good, id: 'metronome_loose_date', installedAt: '1/2/2026' },
        metronome_year_only: { ...good, id: 'metronome_year_only', installedAt: '2026' },
        metronome_bad_dir: { ...good, id: 'metronome_bad_dir', installDir: '../escape' },
        metronome_bad_revision: { ...good, id: 'metronome_bad_revision', catalogRevision: '' },
        metronome_bad_version: { ...good, id: 'metronome_bad_version', version: '1.2' },
        metronome_bad_repo: { ...good, id: 'metronome_bad_repo', repository: 'http://github.com/get-flashbacks/x' },
    };
    putRaw(dir, JSON.stringify({
        schemaVersion: 1,
        updatedAt: INSTALLED_AT,
        plugins: { ...damaged, lyrics: { ...good, id: 'lyrics', installDir: 'lyrics', version: '1.12.2' } },
    }));

    const read = state.readInstalledState(dir);
    assert.strictEqual(read.issue, undefined);
    assert.deepStrictEqual([...read.plugins.keys()], ['lyrics']);
    assert.strictEqual(read.plugins.get('lyrics').version, '1.12.2');
});

test('a record whose key does not match its plugin id is dropped', (t) => {
    const dir = tmpDir(t);
    putRaw(dir, JSON.stringify({
        schemaVersion: 1,
        updatedAt: INSTALLED_AT,
        plugins: { metronome: { ...record(), id: 'lyrics_karaoke' } },
    }));
    assert.strictEqual(state.readInstalledState(dir).plugins.size, 0);
});

test('a record written by a newer app is read as unsupported and never overwritten', (t) => {
    const dir = tmpDir(t);
    const future = JSON.stringify({
        schemaVersion: state.SCHEMA_VERSION + 1,
        updatedAt: INSTALLED_AT,
        plugins: { metronome: { ...record(), pin: '1.2.0' } },
    });
    putRaw(dir, future);

    const read = state.readInstalledState(dir);
    assert.strictEqual(read.issue, 'unsupported-schema');
    assert.strictEqual(read.schemaVersion, state.SCHEMA_VERSION + 1);
    assert.strictEqual(read.plugins.size, 0);
    assert.throws(() => state.writeInstalledState(dir, [record()], INSTALLED_AT), state.InstalledStateError);
    assert.strictEqual(fs.readFileSync(recordPath(dir), 'utf8'), future, 'the newer record must survive');
});

// ── Writing ─────────────────────────────────────────────────────────────────

test('a write refuses an invalid entry or more entries than the cap, and writes nothing', (t) => {
    const dir = tmpDir(t);
    assert.throws(
        () => state.writeInstalledState(dir, [record(), { ...record(), id: 'lyrics', commit: 'main' }], INSTALLED_AT),
        state.InstalledStateError,
    );
    assert.strictEqual(fs.existsSync(recordPath(dir)), false, 'nothing may be written when one entry is invalid');

    const many = Array.from({ length: 501 }, (_, i) => record({ id: `plugin_${i}`, installDir: `plugin_${i}` }));
    assert.throws(() => state.writeInstalledState(dir, many, INSTALLED_AT), state.InstalledStateError);
    assert.strictEqual(fs.existsSync(recordPath(dir)), false);
});

test('a write refuses two plugins claiming one id or one directory', (t) => {
    const dir = tmpDir(t);
    // Uninstall and rollback address a copy by installDir, so an ambiguous
    // directory would make them unsafe.
    assert.throws(() => state.writeInstalledState(dir, [record(), record()], INSTALLED_AT), state.InstalledStateError);
    assert.throws(
        () => state.writeInstalledState(dir, [record(), record({ id: 'feedpakr' })], INSTALLED_AT),
        state.InstalledStateError,
    );
    assert.throws(
        () => state.writeInstalledState(dir, [record(), record({ id: 'feedpakr', installDir: 'Metronome' })], INSTALLED_AT),
        state.InstalledStateError,
    );
    assert.strictEqual(fs.existsSync(recordPath(dir)), false);
});

test('the record is replaced atomically: the old body survives until the rename lands', (t) => {
    const dir = tmpDir(t);
    state.writeInstalledState(dir, [record()], INSTALLED_AT);
    const before = fs.readFileSync(recordPath(dir), 'utf8');

    const rename = fs.renameSync;
    let observed = null;
    fs.renameSync = function (from, to) {
        // At rename time the live record must still be the complete old body and
        // the temp file the complete new one: no reader can observe a mix.
        observed = { live: fs.readFileSync(to, 'utf8'), staged: fs.readFileSync(from, 'utf8') };
        return rename.call(fs, from, to);
    };
    t.after(() => { fs.renameSync = rename; });

    state.writeInstalledState(dir, [record({ version: '2.0.0' })], INSTALLED_AT);

    assert.strictEqual(observed.live, before);
    assert.strictEqual(JSON.parse(observed.staged).plugins.metronome.version, '2.0.0');
    assert.strictEqual(JSON.parse(fs.readFileSync(recordPath(dir), 'utf8')).plugins.metronome.version, '2.0.0');
    assert.strictEqual(fs.existsSync(tempPath(dir)), false, 'the temp file must not survive the write');
});

test('a failed write leaves the previous record intact and reports the failure', (t) => {
    const dir = tmpDir(t);
    state.writeInstalledState(dir, [record()], INSTALLED_AT);
    const before = fs.readFileSync(recordPath(dir), 'utf8');

    const rename = fs.renameSync;
    fs.renameSync = function () {
        const error = new Error('rename failed');
        error.code = 'EIO';
        throw error;
    };
    t.after(() => { fs.renameSync = rename; });

    assert.throws(() => state.writeInstalledState(dir, [record({ version: '9.9.9' })], INSTALLED_AT), state.InstalledStateError);
    assert.strictEqual(fs.readFileSync(recordPath(dir), 'utf8'), before, 'a failed write must not truncate the record');
    assert.strictEqual(fs.existsSync(tempPath(dir)), false, 'the temp file must not be left behind');
    assert.strictEqual(state.readInstalledState(dir).plugins.get('metronome').version, '1.2.0');
});

test('a leftover temp file from a crash is ignored by readers and replaced by the next write', (t) => {
    const dir = tmpDir(t);
    state.writeInstalledState(dir, [record({ version: '1.0.0' })], INSTALLED_AT);
    fs.writeFileSync(tempPath(dir), '{"schemaVersion": 1, "plugins": {"metronome":');

    assert.strictEqual(state.readInstalledState(dir).plugins.get('metronome').version, '1.0.0');
    state.writeInstalledState(dir, [record({ version: '3.0.0' })], INSTALLED_AT);
    assert.strictEqual(state.readInstalledState(dir).plugins.get('metronome').version, '3.0.0');
    assert.strictEqual(fs.existsSync(tempPath(dir)), false);
});

test('a write creates the state directory and replaces a squatting symlink instead of writing through it', (t) => {
    const dir = tmpDir(t);
    const nested = path.join(dir, 'state');
    state.writeInstalledState(nested, [record()], INSTALLED_AT);
    assert.strictEqual(state.readInstalledState(nested).plugins.size, 1);

    const outside = path.join(dir, 'outside.json');
    fs.writeFileSync(outside, 'untouched');
    for (const target of [recordPath(dir), tempPath(dir)]) {
        fs.rmSync(target, { force: true });
        fs.symlinkSync(outside, target);
        state.writeInstalledState(dir, [record()], INSTALLED_AT);
        assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'untouched', `a write must not follow ${target}`);
    }
    assert.ok(fs.lstatSync(recordPath(dir)).isFile(), 'the record must end up a plain file');
    assert.strictEqual(state.readInstalledState(dir).plugins.size, 1);
});