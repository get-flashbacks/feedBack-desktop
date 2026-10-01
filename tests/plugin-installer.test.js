'use strict';

// Catalog plugin installer (issue #3): archive validation, manifest/hash
// checks, staging + atomic swap, rollback, and batch semantics. Archives are
// built in-memory by a tiny ZIP writer so each malicious shape is explicit.

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');

// Compile options come from tsconfig.json so the shim cannot drift from what
// `npm run typecheck` and `npm run build:ts` use.
const tsconfig = ts.readConfigFile(path.join(ROOT, 'tsconfig.json'), ts.sys.readFile);
if (tsconfig.error) throw new Error(ts.flattenDiagnosticMessageText(tsconfig.error.messageText, '\n'));
const { options: compilerOptions } = ts.parseJsonConfigFileContent(tsconfig.config, ts.sys, ROOT);

// Let the installer's `import './plugin-archive'` resolve to the .ts source.
require.extensions['.ts'] = function compileTs(module, filename) {
    const source = fs.readFileSync(filename, 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions, fileName: filename });
    module._compile(outputText, filename);
};
const archiveMod = require(path.join(ROOT, 'src/main/plugin-archive.ts'));
const installer = require(path.join(ROOT, 'src/main/plugin-installer.ts'));

// ── ZIP writer ────────────────────────────────────────────────────────────

function crc(buf) { return archiveMod.crc32(buf); }

/**
 * entries: [{ name, data?, mode?, deflate?, flags?, crcOverride?, sizeOverride? }]
 * A name ending in '/' is a directory. `mode` sets Unix permission bits
 * (made-by host 3); omit for an MS-DOS entry like GitHub's directories.
 */
function makeZip(entries, comment = '') {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const e of entries) {
        const name = Buffer.from(e.name, 'utf8');
        const data = Buffer.from(e.data || '');
        const isDir = e.name.endsWith('/');
        const deflate = !isDir && e.deflate !== false;
        const payload = deflate ? zlib.deflateRawSync(data) : data;
        const method = deflate ? 8 : 0;
        const flags = e.flags ?? 0x0800;
        const c = e.crcOverride ?? crc(data);
        const usize = e.sizeOverride ?? data.length;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(flags, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(c, 14);
        local.writeUInt32LE(payload.length, 18);
        local.writeUInt32LE(usize, 22);
        local.writeUInt16LE(name.length, 26);
        locals.push(local, name, payload);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(e.mode !== undefined ? (3 << 8) | 20 : 20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(flags, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(c, 16);
        central.writeUInt32LE(payload.length, 20);
        central.writeUInt32LE(usize, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(e.mode !== undefined ? (e.mode << 16) >>> 0 : 0, 38);
        central.writeUInt32LE(e.offsetOverride ?? offset, 42);
        centrals.push(central, name);
        offset += local.length + name.length + payload.length;
    }
    const cd = Buffer.concat(centrals);
    const commentBuf = Buffer.from(comment, 'latin1');
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(commentBuf.length, 20);
    return Buffer.concat([...locals, cd, eocd, commentBuf]);
}

const COMMIT = 'c'.repeat(40);
const PREFIX = `feedBack-plugin-example-${COMMIT}/`;

function pluginZip({ id = 'example', version = '1.0.0', extra = [], manifest, prefix = PREFIX, comment = COMMIT } = {}) {
    const manifestText = manifest ?? JSON.stringify({ id, name: 'Example', version });
    return makeZip([
        { name: prefix },
        { name: `${prefix}plugin.json`, data: manifestText, mode: 0o100644 },
        { name: `${prefix}screen.js`, data: `console.log(${JSON.stringify(version)});`, mode: 0o100644 },
        { name: `${prefix}tools/` },
        { name: `${prefix}tools/run.sh`, data: '#!/bin/sh\n', mode: 0o100755 },
        ...extra.map(e => ({ ...e, name: prefix + e.name })),
    ], comment);
}

function sumSizes(zip) {
    return archiveMod.parseArchive(zip).totalUncompressedBytes;
}

function entryFor(zip, overrides = {}) {
    return {
        id: 'example',
        installDir: 'example',
        name: 'Example',
        description: 'Example plugin',
        repository: 'https://github.com/get-flashbacks/feedBack-plugin-example',
        version: '1.0.0',
        commit: COMMIT,
        archiveSha256: crypto.createHash('sha256').update(zip).digest('hex'),
        source: 'get-flashbacks',
        dependencies: [],
        conflicts: [],
        size: { downloadBytes: zip.length, installedBytes: sumSizes(zip) },
        ...overrides,
    };
}

function fakeFetch(map, calls = []) {
    return async (url) => {
        calls.push(url);
        const item = map[url];
        if (!item) return { ok: false, status: 404, url, headers: { get: () => null }, body: null };
        const body = item.body;
        return {
            ok: true,
            status: 200,
            url: item.finalUrl || url,
            headers: { get: (name) => (name === 'content-length' && item.contentLength !== undefined ? String(item.contentLength) : null) },
            body: (async function* () {
                for (let i = 0; i < body.length; i += 1000) yield body.subarray(i, i + 1000);
            })(),
        };
    };
}

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'fb-installer-'));
}

function listTree(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        out.push(entry.name + (entry.isDirectory() ? '/' : ''));
        if (entry.isDirectory()) for (const child of listTree(full)) out.push(`${entry.name}/${child}`);
    }
    return out.sort();
}

// ── Archive reader ────────────────────────────────────────────────────────

test('a valid GitHub-shaped archive parses and extracts with permissions', () => {
    const zip = pluginZip();
    const parsed = archiveMod.parseArchive(zip);
    assert.strictEqual(parsed.comment, COMMIT);
    assert.strictEqual(archiveMod.singleRootPrefix(parsed), PREFIX);
    const dir = tmpDir();
    const dest = path.join(dir, 'out');
    archiveMod.extractArchive(zip, parsed, PREFIX, dest);
    assert.deepStrictEqual(listTree(dest), ['plugin.json', 'screen.js', 'tools/', 'tools/run.sh']);
    if (process.platform !== 'win32') {
        assert.ok(fs.statSync(path.join(dest, 'tools/run.sh')).mode & 0o100);
        assert.ok(!(fs.statSync(path.join(dest, 'screen.js')).mode & 0o100));
    }
});

test('archive paths: traversal, absolute, drive, backslash, and reserved names are rejected', () => {
    const bad = [
        `${PREFIX}../escape.js`,
        '/etc/passwd',
        'C:/Windows/evil.dll',
        `${PREFIX}sub\\..\\..\\evil.js`,
        `${PREFIX}a//b.js`,
        `${PREFIX}./x.js`,
        `${PREFIX}CON.txt`,
        `${PREFIX}trailing. `,
        `${PREFIX}stream:ads`,
    ];
    for (const name of bad) {
        const zip = makeZip([{ name: PREFIX }, { name, data: 'x' }]);
        assert.throws(() => archiveMod.parseArchive(zip), archiveMod.ArchiveError, name);
    }
});

test('names that merely start with dots are not treated as traversal', () => {
    // GitHub stores names as UTF-8 with the UTF-8 flag clear, so a non-ASCII
    // name has to decode as UTF-8 rather than be rejected as CP437.
    const zip = pluginZip({ extra: [{ name: '..config/', data: undefined }, { name: '..dotfile.js', data: 'x' }, { name: 'ünïcode/日本語.js', data: 'y' }] });
    const parsed = archiveMod.parseArchive(zip);
    const dest = path.join(tmpDir(), 'out');
    archiveMod.extractArchive(zip, parsed, PREFIX, dest);
    assert.ok(listTree(dest).includes('..config/'));
    assert.ok(listTree(dest).includes('..dotfile.js'));
    assert.ok(listTree(dest).includes('ünïcode/日本語.js'), 'a UTF-8 name without the UTF-8 flag decodes');
});

test('symbolic links and special files are rejected', () => {
    const link = makeZip([{ name: PREFIX }, { name: `${PREFIX}link`, data: '../../../etc', mode: 0o120777 }]);
    assert.throws(() => archiveMod.parseArchive(link), /symbolic link/);
    const fifo = makeZip([{ name: PREFIX }, { name: `${PREFIX}fifo`, data: '', mode: 0o010644 }]);
    assert.throws(() => archiveMod.parseArchive(fifo), /special file/);
});

test('case-insensitive duplicate names and unexpected layouts are rejected', () => {
    const dup = makeZip([{ name: PREFIX }, { name: `${PREFIX}A.js`, data: '1' }, { name: `${PREFIX}a.js`, data: '2' }]);
    assert.throws(() => archiveMod.parseArchive(dup), /duplicate/);
    const loose = makeZip([{ name: 'plugin.json', data: '{}' }]);
    assert.throws(() => archiveMod.singleRootPrefix(archiveMod.parseArchive(loose)), /unexpected layout/);
    const twoRoots = makeZip([{ name: 'a/x', data: '1' }, { name: 'b/y', data: '2' }]);
    assert.throws(() => archiveMod.singleRootPrefix(archiveMod.parseArchive(twoRoots)), /unexpected layout/);
});

test('size limits, lying sizes, bad CRCs, encryption, and garbage are rejected', () => {
    const big = makeZip([{ name: PREFIX }, { name: `${PREFIX}big.bin`, data: Buffer.alloc(4096) }]);
    const limits = { ...archiveMod.DEFAULT_ARCHIVE_LIMITS, maxTotalBytes: 1024 };
    assert.throws(() => archiveMod.parseArchive(big, limits), /size limit/);
    assert.throws(() => archiveMod.parseArchive(big, { ...limits, maxTotalBytes: 1e9, maxEntryBytes: 100 }), /too large/);
    assert.throws(() => archiveMod.parseArchive(big, { ...limits, maxTotalBytes: 1e9, maxEntries: 1 }), /too many entries/);

    // Declares 10 bytes but inflates to 4096: the bounded inflate refuses.
    const bomb = makeZip([{ name: PREFIX }, { name: `${PREFIX}bomb`, data: Buffer.alloc(4096), sizeOverride: 10 }]);
    const parsedBomb = archiveMod.parseArchive(bomb);
    assert.throws(() => archiveMod.extractArchive(bomb, parsedBomb, PREFIX, path.join(tmpDir(), 'o')), archiveMod.ArchiveError);

    const badCrc = makeZip([{ name: PREFIX }, { name: `${PREFIX}x`, data: 'hello', crcOverride: 1234 }]);
    assert.throws(() => archiveMod.extractArchive(badCrc, archiveMod.parseArchive(badCrc), PREFIX, path.join(tmpDir(), 'o')), /CRC/);

    const encrypted = makeZip([{ name: PREFIX }, { name: `${PREFIX}x`, data: 'hello', flags: 0x0801 }]);
    assert.throws(() => archiveMod.parseArchive(encrypted), /encrypted/);

    assert.throws(() => archiveMod.parseArchive(Buffer.from('not a zip at all, just text padding')), /not a valid ZIP/);

    // Two directory records pointing at the same local data (overlap).
    const a = makeZip([{ name: `${PREFIX}x`, data: 'aaaa' }, { name: `${PREFIX}y`, data: 'bbbb' }]);
    const overlapping = makeZip([{ name: `${PREFIX}x`, data: 'aaaa' }, { name: `${PREFIX}x2`, data: 'aaaa', offsetOverride: 0 }]);
    assert.ok(archiveMod.parseArchive(a));
    assert.throws(() => archiveMod.parseArchive(overlapping), archiveMod.ArchiveError);
});

// ── Catalog entry + download validation ───────────────────────────────────

test('the bundled catalog loads with every entry accepted by the installer', () => {
    const catalog = installer.loadCatalog(path.join(ROOT, 'resources', 'plugin-catalog.json'));
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'resources', 'plugin-catalog.json'), 'utf8'));
    assert.strictEqual(catalog.entries.length, raw.entries.length);
    for (const entry of catalog.entries) {
        assert.match(installer.archiveUrlFor(entry), /^https:\/\/codeload\.github\.com\/[^/]+\/[^/]+\/zip\/[0-9a-f]{40}$/);
    }
});

test('catalog entries must use approved HTTPS repositories and immutable pins', () => {
    const zip = pluginZip();
    assert.ok(installer.validateCatalogEntry(entryFor(zip)));
    const bad = [
        { repository: 'http://github.com/get-flashbacks/feedBack-plugin-example' },
        { repository: 'https://gitlab.com/get-flashbacks/feedBack-plugin-example' },
        { repository: 'https://github.com/someone-else/feedBack-plugin-example' },
        { repository: 'https://github.com/get-flashbacks/repo/../../x' },
        { source: 'upstream-official' },
        { commit: 'main' },
        { archiveSha256: 'abc' },
        { installDir: '../escape' },
        { size: { downloadBytes: 0, installedBytes: 1 } },
    ];
    for (const override of bad) assert.ok(!installer.validateCatalogEntry(entryFor(zip, override)), JSON.stringify(override));
    assert.ok(installer.validateCatalogEntry(entryFor(zip, {
        source: 'upstream-official', repository: 'https://github.com/got-feedBack/feedBack-plugin-example',
    })));
    assert.ok(installer.validateCatalogEntry(entryFor(zip, {
        source: 'reviewed-community', repository: 'https://github.com/someone-else/feedBack-plugin-example',
    })));
});

test('downloads are size-capped, host-pinned, and hash-verified', async () => {
    const zip = pluginZip();
    const entry = entryFor(zip);
    const url = installer.archiveUrlFor(entry);
    assert.strictEqual(url, `https://codeload.github.com/get-flashbacks/feedBack-plugin-example/zip/${COMMIT}`);

    assert.ok((await installer.downloadArchive(entry, fakeFetch({ [url]: { body: zip } }))).equals(zip));

    const tampered = Buffer.from(zip);
    tampered[tampered.length - 50] ^= 0xff;
    await assert.rejects(installer.downloadArchive(entry, fakeFetch({ [url]: { body: tampered } })), /integrity check/);
    await assert.rejects(installer.downloadArchive(entry, fakeFetch({ [url]: { body: Buffer.concat([zip, Buffer.alloc(10)]) } })), /larger than/);
    await assert.rejects(installer.downloadArchive(entry, fakeFetch({ [url]: { body: zip, contentLength: zip.length + 1 } })), /larger than/);
    await assert.rejects(installer.downloadArchive(entry, fakeFetch({ [url]: { body: zip.subarray(0, 100) } })), /incomplete/);
    await assert.rejects(installer.downloadArchive(entry, fakeFetch({ [url]: { body: zip, finalUrl: 'https://evil.example/x' } })), /unexpected location/);
    await assert.rejects(installer.downloadArchive(entry, fakeFetch({ [url]: { body: zip, finalUrl: url.replace('https:', 'http:') } })), /unexpected location/);
    await assert.rejects(installer.downloadArchive(entry, fakeFetch({})), /HTTP 404/);
    await assert.rejects(installer.downloadArchive(entry, async () => { throw new Error('ENOTFOUND'); }), /internet connection/);
});

test('archive provenance and manifest must match the catalog entry', () => {
    const good = pluginZip();
    assert.strictEqual(installer.verifyArchive(good, entryFor(good)).manifest.id, 'example');

    const wrongRoot = pluginZip({ prefix: `feedBack-plugin-example-${'d'.repeat(40)}/` });
    assert.throws(() => installer.verifyArchive(wrongRoot, entryFor(wrongRoot)), /pinned commit/);
    const wrongComment = pluginZip({ comment: 'd'.repeat(40) });
    assert.throws(() => installer.verifyArchive(wrongComment, entryFor(wrongComment)), /pinned commit/);
    const wrongId = pluginZip({ id: 'other' });
    assert.throws(() => installer.verifyArchive(wrongId, entryFor(wrongId)), /unexpected plugin id/);
    const wrongVersion = pluginZip({ version: '2.0.0' });
    assert.throws(() => installer.verifyArchive(wrongVersion, entryFor(wrongVersion)), /unexpected version/);
    const badJson = pluginZip({ manifest: '{not json' });
    assert.throws(() => installer.verifyArchive(badJson, entryFor(badJson)), /invalid plugin.json/);
    const noManifest = makeZip([{ name: PREFIX }, { name: `${PREFIX}screen.js`, data: 'x' }], COMMIT);
    assert.throws(() => installer.verifyArchive(noManifest, entryFor(noManifest)), /does not contain a plugin.json/);
    assert.throws(() => installer.verifyArchive(good, entryFor(good, { size: { downloadBytes: good.length, installedBytes: 1 } })), /catalog size/);
    const symlinked = pluginZip({ extra: [{ name: 'evil', data: '/etc', mode: 0o120777 }] });
    assert.throws(() => installer.verifyArchive(symlinked, entryFor(symlinked)), /symbolic link/);
});

// ── Install transaction ───────────────────────────────────────────────────

function setup(zip, overrides) {
    const pluginsDir = path.join(tmpDir(), 'plugins');
    fs.mkdirSync(pluginsDir);
    const entry = entryFor(zip, overrides);
    const calls = [];
    const fetch = fakeFetch({ [installer.archiveUrlFor(entry)]: { body: zip } }, calls);
    return { pluginsDir, entry, fetch, calls };
}

test('a fresh install lands atomically and leaves no staging behind', async () => {
    const { pluginsDir, entry, fetch } = setup(pluginZip());
    const outcome = await installer.installCatalogEntry(entry, { pluginsDir, fetch });
    assert.deepStrictEqual(outcome, { id: 'example', installDir: 'example', version: '1.0.0', hadPrevious: false });
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(pluginsDir, 'example', 'plugin.json'))).version, '1.0.0');
    assert.ok(!fs.existsSync(path.join(pluginsDir, installer.STAGING_DIR)));
    assert.ok(!installer.hasBackup(pluginsDir, 'example'));
});

test('failed downloads or validation leave no partially installed plugin', async () => {
    const zip = pluginZip();
    for (const breakIt of [
        (s) => { s.entry.archiveSha256 = '0'.repeat(64); },
        (s) => { s.fetch = fakeFetch({}); },
        (s) => { s.entry.version = '9.9.9'; s.fetch = fakeFetch({ [installer.archiveUrlFor(s.entry)]: { body: zip } }); },
    ]) {
        const s = setup(zip);
        breakIt(s);
        await assert.rejects(installer.installCatalogEntry(s.entry, { pluginsDir: s.pluginsDir, fetch: s.fetch }), installer.InstallError);
        assert.ok(!fs.existsSync(path.join(s.pluginsDir, 'example')));
        const staging = path.join(s.pluginsDir, installer.STAGING_DIR);
        assert.ok(!fs.existsSync(staging) || fs.readdirSync(staging).length === 0);
    }
});

test('extraction failure does not touch a working installation', async () => {
    // Passes every pre-extraction check, then fails the bounded inflate.
    const bombed = pluginZip({ extra: [{ name: 'bomb', data: Buffer.alloc(4096), sizeOverride: 10 }] });
    const { pluginsDir, entry, fetch } = setup(bombed);
    fs.mkdirSync(path.join(pluginsDir, 'example'));
    fs.writeFileSync(path.join(pluginsDir, 'example', 'plugin.json'), JSON.stringify({ id: 'example', name: 'Example', version: '0.9.0' }));
    await assert.rejects(installer.installCatalogEntry(entry, { pluginsDir, fetch }), /rejected/);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(pluginsDir, 'example', 'plugin.json'))).version, '0.9.0');
    assert.ok(!installer.hasBackup(pluginsDir, 'example'));
});

test('an update keeps the previous version for rollback and never touches user data', async () => {
    const zip = pluginZip({ version: '1.0.0' });
    const { pluginsDir, entry, fetch } = setup(zip);
    const configDir = path.join(path.dirname(pluginsDir), 'config');
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, 'example.json'), '{"setting":true}');
    fs.mkdirSync(path.join(pluginsDir, 'other'));
    fs.writeFileSync(path.join(pluginsDir, 'other', 'plugin.json'), JSON.stringify({ id: 'other', name: 'Other', version: '1.0.0' }));
    fs.mkdirSync(path.join(pluginsDir, 'example'));
    fs.writeFileSync(path.join(pluginsDir, 'example', 'plugin.json'), JSON.stringify({ id: 'example', name: 'Example', version: '0.9.0' }));

    const outcome = await installer.installCatalogEntry(entry, { pluginsDir, fetch });
    assert.strictEqual(outcome.hadPrevious, true);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(pluginsDir, 'example', 'plugin.json'))).version, '1.0.0');
    assert.ok(installer.hasBackup(pluginsDir, 'example'));
    assert.strictEqual(fs.readFileSync(path.join(configDir, 'example.json'), 'utf8'), '{"setting":true}');
    assert.ok(fs.existsSync(path.join(pluginsDir, 'other', 'plugin.json')));

    assert.strictEqual(await installer.rollbackInstall(pluginsDir, 'example'), 'restored');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(pluginsDir, 'example', 'plugin.json'))).version, '0.9.0');
    assert.ok(!installer.hasBackup(pluginsDir, 'example'));
});

test('a second unconfirmed update keeps the last known-good backup', async () => {
    const { pluginsDir, entry, fetch } = setup(pluginZip());
    fs.mkdirSync(path.join(pluginsDir, 'example'));
    fs.writeFileSync(path.join(pluginsDir, 'example', 'plugin.json'), JSON.stringify({ id: 'example', name: 'Example', version: '0.8.0' }));
    await installer.installCatalogEntry(entry, { pluginsDir, fetch });
    await installer.installCatalogEntry(entry, { pluginsDir, fetch: fakeFetch({ [installer.archiveUrlFor(entry)]: { body: pluginZip() } }) });
    await installer.rollbackInstall(pluginsDir, 'example');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(pluginsDir, 'example', 'plugin.json'))).version, '0.8.0');
});

test('rollback of a fresh install removes it; commit drops the backup', async () => {
    const { pluginsDir, entry, fetch } = setup(pluginZip());
    await installer.installCatalogEntry(entry, { pluginsDir, fetch });
    assert.strictEqual(await installer.rollbackInstall(pluginsDir, 'example'), 'removed');
    assert.ok(!fs.existsSync(path.join(pluginsDir, 'example')));

    fs.mkdirSync(path.join(pluginsDir, 'example'));
    fs.writeFileSync(path.join(pluginsDir, 'example', 'plugin.json'), JSON.stringify({ id: 'example', name: 'Example', version: '0.9.0' }));
    await installer.installCatalogEntry(entry, { pluginsDir, fetch: fakeFetch({ [installer.archiveUrlFor(entry)]: { body: pluginZip() } }) });
    installer.commitInstall(pluginsDir, 'example');
    assert.ok(!installer.hasBackup(pluginsDir, 'example'));
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(pluginsDir, 'example', 'plugin.json'))).version, '1.0.0');
});

test('destinations owned by another plugin, symlinks, files, and protected ids are refused', async () => {
    const zip = pluginZip();
    let s = setup(zip);
    fs.mkdirSync(path.join(s.pluginsDir, 'example'));
    fs.writeFileSync(path.join(s.pluginsDir, 'example', 'plugin.json'), JSON.stringify({ id: 'someone_else', name: 'X', version: '1.0.0' }));
    await assert.rejects(installer.installCatalogEntry(s.entry, { pluginsDir: s.pluginsDir, fetch: s.fetch }), /different plugin/);
    assert.strictEqual(s.calls.length, 0, 'no download is attempted for an unusable destination');

    s = setup(zip);
    fs.writeFileSync(path.join(s.pluginsDir, 'example'), 'file');
    await assert.rejects(installer.installCatalogEntry(s.entry, { pluginsDir: s.pluginsDir, fetch: s.fetch }), /occupied by a file/);

    if (process.platform !== 'win32') {
        s = setup(zip);
        const checkout = path.join(path.dirname(s.pluginsDir), 'checkout');
        fs.mkdirSync(checkout);
        fs.writeFileSync(path.join(checkout, 'plugin.json'), JSON.stringify({ id: 'example', name: 'E', version: '0.1.0' }));
        fs.symlinkSync(checkout, path.join(s.pluginsDir, 'example'));
        await assert.rejects(installer.installCatalogEntry(s.entry, { pluginsDir: s.pluginsDir, fetch: s.fetch }), /development checkout/);
        assert.ok(fs.existsSync(path.join(checkout, 'plugin.json')));
    }

    s = setup(zip);
    await assert.rejects(
        installer.installCatalogEntry(s.entry, { pluginsDir: s.pluginsDir, fetch: s.fetch, protectedIds: new Set(['example']) }),
        /ships with the application/,
    );

    s = setup(zip, { installDir: '..' });
    await assert.rejects(installer.installCatalogEntry(s.entry, { pluginsDir: s.pluginsDir, fetch: s.fetch }), /not available/);
});

test('error messages do not leak filesystem paths', async () => {
    const s = setup(pluginZip());
    fs.writeFileSync(path.join(s.pluginsDir, 'example'), 'file');
    const err = await installer.installCatalogEntry(s.entry, { pluginsDir: s.pluginsDir, fetch: s.fetch }).catch(e => e);
    assert.ok(!err.message.includes(s.pluginsDir));
    assert.ok(!err.message.includes(os.tmpdir()));
});

// ── Batch ─────────────────────────────────────────────────────────────────

function batchSetup() {
    const pluginsDir = path.join(tmpDir(), 'plugins');
    fs.mkdirSync(pluginsDir);
    const make = (id, version, extra = {}) => {
        const prefix = `feedBack-plugin-${id}-${COMMIT}/`;
        const zip = pluginZip({ id, version, prefix });
        return entryFor(zip, {
            id, installDir: id, name: id.toUpperCase(), version,
            repository: `https://github.com/get-flashbacks/feedBack-plugin-${id}`, ...extra, _zip: zip,
        });
    };
    const entries = [make('alpha', '1.0.0'), make('beta', '1.0.0'), make('gamma', '1.0.0', { dependencies: ['missing_dep'] })];
    // beta's archive is tampered with, so only beta should fail.
    const map = {};
    for (const e of entries) {
        const body = e.id === 'beta' ? Buffer.from(e._zip).fill(0, 40, 60) : e._zip;
        map[installer.archiveUrlFor(e)] = { body };
    }
    const catalog = { entries, byId: new Map(entries.map(e => [e.id, e])) };
    return { pluginsDir, catalog, fetch: fakeFetch(map) };
}

test('batch: one failing plugin does not affect others and the backend restarts once', async () => {
    const { pluginsDir, catalog, fetch } = batchSetup();
    let activations = 0;
    const results = await installer.installCatalogBatch(['alpha', 'beta', 'gamma', 'nope'], catalog, {
        pluginsDir,
        fetch,
        installedIds: new Set(),
        activate: async (outcomes) => {
            activations++;
            return new Map(outcomes.map(o => [o.id, { ok: true }]));
        },
    });
    assert.strictEqual(activations, 1);
    const byId = Object.fromEntries(results.map(r => [r.id, r]));
    assert.strictEqual(byId.alpha.success, true);
    assert.strictEqual(byId.beta.success, false);
    assert.match(byId.beta.message, /integrity/);
    assert.strictEqual(byId.gamma.success, false);
    assert.match(byId.gamma.message, /requires missing_dep/);
    assert.strictEqual(byId.nope.success, false);
    assert.ok(fs.existsSync(path.join(pluginsDir, 'alpha', 'plugin.json')));
    assert.ok(!fs.existsSync(path.join(pluginsDir, 'beta')));
    assert.ok(!fs.existsSync(path.join(pluginsDir, 'gamma')));
});

test('batch: a failed activation restores the previous version and restarts once more', async () => {
    const { pluginsDir, catalog, fetch } = batchSetup();
    fs.mkdirSync(path.join(pluginsDir, 'alpha'));
    fs.writeFileSync(path.join(pluginsDir, 'alpha', 'plugin.json'), JSON.stringify({ id: 'alpha', name: 'A', version: '0.5.0' }));
    let restarts = 0;
    const results = await installer.installCatalogBatch(['alpha'], catalog, {
        pluginsDir,
        fetch,
        installedIds: new Set(['alpha']),
        activate: async () => new Map([['alpha', { ok: false, message: 'the server reported a load error' }]]),
        restartAfterRollback: async () => { restarts++; },
    });
    assert.strictEqual(results[0].success, false);
    assert.match(results[0].message, /previous version was restored/);
    assert.strictEqual(restarts, 1);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(pluginsDir, 'alpha', 'plugin.json'))).version, '0.5.0');
});

test('batch: an unconfirmed activation keeps the backup and says so', async () => {
    const { pluginsDir, catalog, fetch } = batchSetup();
    fs.mkdirSync(path.join(pluginsDir, 'alpha'));
    fs.writeFileSync(path.join(pluginsDir, 'alpha', 'plugin.json'), JSON.stringify({ id: 'alpha', name: 'A', version: '0.5.0' }));
    let restarts = 0;
    const results = await installer.installCatalogBatch(['alpha'], catalog, {
        pluginsDir,
        fetch,
        installedIds: new Set(['alpha']),
        activate: async () => new Map([['alpha', { ok: true, confirmed: false }]]),
        restartAfterRollback: async () => { restarts++; },
    });
    assert.strictEqual(results[0].success, true);
    assert.match(results[0].message, /activation was not confirmed/);
    // The only copy of the version the user was running must survive.
    assert.ok(installer.hasBackup(pluginsDir, 'alpha'), 'backup is kept for an unconfirmed install');
    assert.strictEqual(restarts, 0);
    assert.strictEqual(await installer.rollbackInstall(pluginsDir, 'alpha'), 'restored');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(pluginsDir, 'alpha', 'plugin.json'))).version, '0.5.0');
});

test('batch: a confirmed activation still commits the backup', async () => {
    const { pluginsDir, catalog, fetch } = batchSetup();
    fs.mkdirSync(path.join(pluginsDir, 'alpha'));
    fs.writeFileSync(path.join(pluginsDir, 'alpha', 'plugin.json'), JSON.stringify({ id: 'alpha', name: 'A', version: '0.5.0' }));
    const results = await installer.installCatalogBatch(['alpha'], catalog, {
        pluginsDir,
        fetch,
        installedIds: new Set(['alpha']),
        activate: async (outcomes) => new Map(outcomes.map(o => [o.id, { ok: true, confirmed: true }])),
    });
    assert.strictEqual(results[0].success, true);
    assert.ok(!installer.hasBackup(pluginsDir, 'alpha'));
});

test('batch: an activation check that throws keeps the backup', async () => {
    const { pluginsDir, catalog, fetch } = batchSetup();
    fs.mkdirSync(path.join(pluginsDir, 'alpha'));
    fs.writeFileSync(path.join(pluginsDir, 'alpha', 'plugin.json'), JSON.stringify({ id: 'alpha', name: 'A', version: '0.5.0' }));
    const results = await installer.installCatalogBatch(['alpha'], catalog, {
        pluginsDir,
        fetch,
        installedIds: new Set(['alpha']),
        activate: async () => { throw new Error('ECONNRESET'); },
    });
    assert.strictEqual(results[0].success, true);
    assert.match(results[0].message, /Restart the app/);
    assert.ok(installer.hasBackup(pluginsDir, 'alpha'), 'backup survives an unusable activation check');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(pluginsDir, 'alpha', 'plugin.json'))).version, '1.0.0');
});

test('batch: no activation or restart happens when nothing was installed', async () => {
    const { pluginsDir, catalog, fetch } = batchSetup();
    let activations = 0;
    await installer.installCatalogBatch(['beta'], catalog, {
        pluginsDir, fetch, installedIds: new Set(), activate: async () => { activations++; return new Map(); },
    });
    assert.strictEqual(activations, 0);
});
