'use strict';

// Plugin lifecycle decisions (issue #21, lifecycle 2/6 of #6): the pure rules that
// decide what an update, a downgrade, a pin, a disable and an uninstall may do to
// one installed plugin. Every one of those rules is a refusal — something the app
// must *not* do — so they are tested as such: a pin holds updates, a disabled
// plugin is untouched, a downgrade only reinstalls an archive the record already
// vouched for, and user data is only ever addressed inside the config dir.
//
// plugin-manager.ts performs the disk work these answers authorize; this file
// needs no electron, no filesystem and no network.

const assert = require('node:assert');
const path = require('node:path');
const test = require('node:test');

const { loadTs, ROOT } = require('./_load-ts');

// `loadTs` compiles the named module fresh; the ones it pulls in by relative
// specifier go through node's require cache. Load them all the same way so that
// `installer.InstallError` is the very class plugin-lifecycle.ts throws.
const lifecycle = loadTs('src/main/plugin-lifecycle.ts');
const state = require(path.join(ROOT, 'src/main/plugin-installed-state.ts'));
const installer = require(path.join(ROOT, 'src/main/plugin-installer.ts'));

const {
    compareVersions,
    downgradeCandidates,
    entryForPin,
    installRefusal,
    isUpdateAvailable,
    lifecycleView,
    nextRecordAfterInstall,
    pluginIdFrom,
    recordAfterPinChange,
    recordAfterRollback,
    resolveUpdate,
    splitLifecycleRequests,
    updateCandidates,
    updateStatusFor,
    userDataPathsForPlugin,
    versionFrom,
} = lifecycle;

const COMMIT = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);
const CATALOG_REVISION = 'c'.repeat(64);
const INSTALLED_AT = '2026-10-02T20:10:51.000Z';
const DIGEST_V1 = 'd'.repeat(64);
const COMMIT_V1 = 'e'.repeat(40);

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
        size: { downloadBytes: 4096, installedBytes: 20480 },
        ...overrides,
    };
}

/**
 * The installed record for the catalog entry, with lifecycle fields overridden.
 * The overrides apply to the record rather than the entry, because `pinned` and
 * `enabled` are states the user sets, not things the catalog can say.
 */
function record(overrides = {}) {
    return { ...state.installedRecordFor(catalogEntry(), CATALOG_REVISION, INSTALLED_AT), ...overrides };
}

function recordedPin(overrides = {}) {
    return {
        version: '1.0.0',
        repository: 'https://github.com/get-flashbacks/feedBack-plugin-metronome',
        commit: COMMIT_V1,
        archiveSha256: DIGEST_V1,
        downloadBytes: 3000,
        installedBytes: 15000,
        catalogRevision: 'f'.repeat(64),
        source: 'get-flashbacks',
        ...overrides,
    };
}

/** A record of `version` with `count` earlier versions in its history, newest first. */
function recordWithHistory(version, count) {
    const previousVersions = Array.from({ length: count }, (_, i) =>
        recordedPin({ version: `0.${count - i}.0`, archiveSha256: String(i).repeat(64) }),
    );
    return { ...record({ version }), ...(previousVersions.length ? { previousVersions } : {}) };
}

// ── Version ordering ────────────────────────────────────────────────────────

test('versions order by release, then by semver prerelease rules', () => {
    assert.strictEqual(compareVersions('1.0.0', '1.0.0'), 0);
    assert.ok(compareVersions('1.0.1', '1.0.0') > 0);
    assert.ok(compareVersions('1.1.0', '1.0.9') > 0);
    assert.ok(compareVersions('2.0.0', '1.99.99') > 0);
    assert.ok(compareVersions('0.9.9', '1.0.0') < 0);

    // A prerelease leads to its release, so the catalog's `1.0.0` is an update
    // over an installed `1.0.0-rc.1` rather than a downgrade.
    assert.ok(compareVersions('1.0.0', '1.0.0-rc.1') > 0);
    assert.ok(compareVersions('1.0.0-rc.2', '1.0.0-rc.1') > 0);
    assert.ok(compareVersions('1.0.0-alpha', '1.0.0-alpha.1') < 0);
    // Numeric identifiers compare numerically, and rank below alphanumeric ones.
    assert.ok(compareVersions('1.0.0-2', '1.0.0-10') < 0);
    assert.ok(compareVersions('1.0.0-1', '1.0.0-alpha') < 0);
    assert.ok(compareVersions('1.0.0-alpha', '1.0.0-beta') < 0);
});

test('a version that is not one the catalog accepts never authorizes an install', () => {
    for (const bad of [undefined, null, 1.2, '', 'v1.2.0', '1.2', '1.2.0.3', 'latest', '1.2.x', '01.2.0-']) {
        assert.strictEqual(compareVersions(bad, '1.0.0'), 0, String(bad));
        assert.strictEqual(compareVersions('1.0.0', bad), 0, String(bad));
    }
});

// ── What the catalog means for one installed copy ───────────────────────────

test('the update status names every state the manager has to handle', () => {
    const entry = catalogEntry();
    assert.strictEqual(updateStatusFor(null, entry), 'not-installed');
    assert.strictEqual(updateStatusFor(record(), undefined), 'not-installed');
    assert.strictEqual(updateStatusFor(record(), entry), 'current');

    // Same version, different archive: the release was re-cut under one version.
    assert.strictEqual(updateStatusFor(record(), catalogEntry({ commit: 'f'.repeat(40) })), 'republished');

    // A newer version in the catalog, and a catalog behind what is installed.
    assert.strictEqual(updateStatusFor(record({ version: '1.0.0' }), entry), 'available');
    assert.strictEqual(updateStatusFor(record({ version: '1.3.0' }), entry), 'ahead');
    // A prerelease leads to its release: the catalog's 1.2.0 is an update over an
    // installed 1.2.0-rc.1, and an installed 1.3.0-rc.1 is ahead of the catalog.
    assert.strictEqual(updateStatusFor(record({ version: '1.2.0-rc.1' }), entry), 'available');
    assert.strictEqual(updateStatusFor(record({ version: '1.3.0-rc.1' }), entry), 'ahead');
});

test('a pin and a disabled state each hold updates, and disabling wins over pinning', () => {
    const older = catalogEntry({ version: '1.3.0', commit: 'f'.repeat(40), archiveSha256: 'f'.repeat(64) });
    const pinned = record({ version: '1.0.0', pinned: true });
    const disabled = record({ version: '1.0.0', enabled: false });
    const both = record({ version: '1.0.0', enabled: false, pinned: true });

    assert.strictEqual(updateStatusFor(pinned, older), 'pinned');
    assert.strictEqual(updateStatusFor(disabled, older), 'disabled');
    assert.strictEqual(updateStatusFor(both, older), 'disabled');
    for (const held of [pinned, disabled, both]) {
        assert.strictEqual(isUpdateAvailable(updateStatusFor(held, older)), false);
        assert.strictEqual(resolveUpdate(held, older), null);
    }

    // A pin also holds a re-cut archive of the version already installed.
    assert.strictEqual(updateStatusFor(record({ version: '1.2.0', pinned: true }), catalogEntry()), 'pinned');
});

test('only an available or re-cut archive resolves to something installable', () => {
    const behind = record({ version: '1.0.0' });
    assert.strictEqual(isUpdateAvailable(updateStatusFor(behind, catalogEntry())), true);
    assert.deepStrictEqual(resolveUpdate(behind, catalogEntry()), catalogEntry());
    assert.strictEqual(resolveUpdate(record(), catalogEntry()), null, 'current installs nothing');
    assert.strictEqual(resolveUpdate(null, catalogEntry()), null);
});

test('the catalog version is refused over a copy that is pinned, disabled, current or ahead', () => {
    const entry = catalogEntry();
    assert.strictEqual(installRefusal(entry, record({ version: '1.0.0' })), null, 'available installs');
    assert.strictEqual(
        installRefusal(entry, record({ commit: 'f'.repeat(40) })),
        null,
        'a release re-cut under the same version installs',
    );

    assert.match(installRefusal(entry, record({ version: '1.2.0' })), /already up to date/);
    assert.match(installRefusal(entry, record({ version: '1.0.0', pinned: true })), /pinned at 1\.0\.0.*Unpin/);
    assert.match(installRefusal(entry, record({ version: '1.0.0', enabled: false })), /disabled.*Enable it/);
    // The catalog is behind the installed copy, so installing it is a downgrade —
    // which only ever reinstalls a pin from the record's own history.
    assert.match(
        installRefusal(entry, record({ version: '1.3.0' })),
        /1\.2\.0\) is older than what is installed \(1\.3\.0\).*Downgrade/,
    );
});

test('a batch install refuses exactly what the per-plugin operation would', () => {
    const CATALOG_DIGEST = '9'.repeat(64);
    const entries = ['metronome', 'pinned', 'disabled', 'ahead', 'current', 'catalogBehind', 'fresh', 'unknown'].map(id =>
        catalogEntry({ id, installDir: id, name: id, version: '2.0.0', archiveSha256: CATALOG_DIGEST }),
    );
    const records = new Map([
        ['metronome', record({ version: '1.0.0' })],
        ['pinned', record({ version: '1.0.0', pinned: true })],
        ['disabled', record({ version: '1.0.0', enabled: false })],
        ['ahead', record({ version: '9.0.0' })],
        ['current', record({ version: '2.0.0', archiveSha256: CATALOG_DIGEST })],
        ['catalogBehind', record({ version: '3.0.0' })],
    ]);

    const split = splitLifecycleRequests(
        ['metronome', 'pinned', 'disabled', 'ahead', 'current', 'catalogBehind', 'fresh', 'unknown'],
        records,
        entries,
    );
    // Selecting a plugin in the catalog list must not be a way around the rule the
    // Update button obeys, so a copy the catalog is behind is refused here too —
    // and an id the catalog has no entry for is left for the batch to report.
    assert.deepStrictEqual(split.allowed, ['metronome', 'fresh', 'unknown']);
    assert.deepStrictEqual(split.refused.map(r => r.id), ['pinned', 'disabled', 'ahead', 'current', 'catalogBehind']);
    for (const refusal of split.refused) {
        assert.strictEqual(refusal.success, false);
        assert.ok(refusal.message.length > 0, refusal.id);
    }
    assert.match(split.refused.find(r => r.id === 'ahead').message, /Downgrade/);
    assert.deepStrictEqual(splitLifecycleRequests([], records, entries), { allowed: [], refused: [] });
});

test('an update check offers only installed plugins that may actually update', () => {
    const CATALOG_DIGEST = '9'.repeat(64);
    const entries = ['metronome', 'pinned', 'disabled', 'ahead', 'current', 'republished', 'unknown'].map(id =>
        catalogEntry({ id, installDir: id, name: id, version: '2.0.0', archiveSha256: CATALOG_DIGEST }),
    );
    const records = new Map([
        ['metronome', record({ version: '1.0.0' })],
        ['pinned', record({ version: '1.0.0', pinned: true })],
        ['disabled', record({ version: '1.0.0', enabled: false })],
        ['ahead', record({ version: '9.0.0' })],
        ['current', record({ version: '2.0.0', archiveSha256: CATALOG_DIGEST })],
        ['republished', record({ version: '2.0.0' })],
    ]);

    assert.deepStrictEqual(
        updateCandidates(records, entries).sort(),
        ['metronome', 'republished'],
        'pinned, disabled, current and unlisted plugins are not offered',
    );
    assert.deepStrictEqual(updateCandidates(new Map(), entries), []);
});

// ── Downgrades ──────────────────────────────────────────────────────────────

test('a downgrade offers the recorded history, minus what is installed now', () => {
    assert.deepStrictEqual(downgradeCandidates(null), []);
    assert.deepStrictEqual(downgradeCandidates(record()), []);

    assert.deepStrictEqual(
        downgradeCandidates(recordWithHistory('1.3.0', 3)).map(pin => pin.version),
        ['0.3.0', '0.2.0', '0.1.0'],
    );

    // A history that lists the installed version anyway must not offer it.
    const selfListed = {
        ...recordWithHistory('1.3.0', 2),
        previousVersions: [recordedPin({ version: '1.3.0' }), recordedPin({ version: '1.2.0' })],
    };
    assert.deepStrictEqual(downgradeCandidates(selfListed).map(pin => pin.version), ['1.2.0']);
});

test('a downgrade reinstalls the archive the record vouched for, never a renderer-supplied URL', () => {
    const rec = recordWithHistory('1.2.0', 2);
    const pin = downgradeCandidates(rec)[0];
    assert.strictEqual(pin.version, '0.2.0');

    assert.deepStrictEqual(entryForPin(rec, pin, 'Metronome'), {
        id: 'metronome',
        installDir: 'metronome',
        name: 'Metronome',
        repository: 'https://github.com/get-flashbacks/feedBack-plugin-metronome',
        version: '0.2.0',
        commit: COMMIT_V1,
        archiveSha256: '0'.repeat(64),
        source: 'get-flashbacks',
        dependencies: [],
        conflicts: [],
        size: { downloadBytes: 3000, installedBytes: 15000 },
    });
    // The URL follows from the record's own commit — there is nowhere for a
    // renderer-supplied archive to enter.
    assert.strictEqual(
        installer.archiveUrlFor(entryForPin(rec, pin, 'Metronome')),
        `https://codeload.github.com/get-flashbacks/feedBack-plugin-metronome/zip/${COMMIT_V1}`,
    );
});

test('a pin the installer would refuse today is refused as a downgrade', () => {
    const rec = recordWithHistory('1.2.0', 2);
    const pin = downgradeCandidates(rec)[1];
    const damaged = {
        tamperedDigest: { archiveSha256: 'not-a-digest' },
        tamperedVersion: { version: 'v1.1.0' },
        tamperedCommit: { commit: 'abc123' },
        tamperedSource: { source: 'made-up' },
        wrongOwner: { source: 'upstream-official' },
        emptyDownload: { downloadBytes: 0 },
        missingDownload: { downloadBytes: undefined },
    };
    for (const [name, override] of Object.entries(damaged)) {
        assert.throws(
            () => entryForPin(rec, { ...pin, ...override }, 'Metronome'),
            installer.InstallError,
            name,
        );
    }
});

// ── Records after an install, a pin and a version change ────────────────────

test('the displaced version joins the history newest first and the pin is dropped', () => {
    const previous = recordWithHistory('1.0.0', 2);
    const previousPinned = record({ version: '1.0.0', pinned: true, enabled: false });
    const next = nextRecordAfterInstall(previousPinned, catalogEntry(), 'd'.repeat(64), '2026-10-05T09:00:00.000Z');

    assert.strictEqual(next.version, '1.2.0');
    assert.strictEqual(next.catalogRevision, 'd'.repeat(64));
    assert.strictEqual(next.installedAt, '2026-10-05T09:00:00.000Z');
    assert.strictEqual(next.pinned, false, 'a version change drops the pin');
    assert.strictEqual(next.enabled, false, 'reinstalling a disabled copy does not re-enable it');
    assert.deepStrictEqual(next.previousVersions, [state.pinFor(previousPinned)], 'the version that was displaced');

    // Chained installs keep the newest first, without duplicating the live one.
    const chained = nextRecordAfterInstall(next, catalogEntry({ version: '1.3.0' }), CATALOG_REVISION, INSTALLED_AT);
    assert.deepStrictEqual(chained.previousVersions.map(pin => pin.version), ['1.2.0', '1.0.0']);
    assert.ok(!chained.previousVersions.some(pin => pin.version === chained.version));
});

test('the history is capped so the record cannot grow without bound', () => {
    let rec = record({ version: '1.0.0' });
    for (let i = 1; i <= state.MAX_HISTORY + 6; i++) {
        rec = nextRecordAfterInstall(rec, catalogEntry({ version: `1.${i}.0`, commit: 'f'.repeat(40) }), CATALOG_REVISION, INSTALLED_AT);
    }
    assert.strictEqual(rec.previousVersions.length, state.MAX_HISTORY);
    assert.strictEqual(rec.previousVersions[0].version, `1.${state.MAX_HISTORY + 5}.0`, 'newest first');
});

test('a first install has no history, and a record too old to vouch for displaces nothing', () => {
    const fresh = nextRecordAfterInstall(null, catalogEntry(), CATALOG_REVISION, INSTALLED_AT);
    assert.deepStrictEqual(fresh, state.installedRecordFor(catalogEntry(), CATALOG_REVISION, INSTALLED_AT));
    assert.ok(!('previousVersions' in fresh));

    // A v1-era record has no source or sizes, so it cannot be recorded as a
    // rollback target — a downgrade is offered only from a validated pin.
    const legacy = {
        id: 'metronome',
        installDir: 'metronome',
        version: '1.0.0',
        repository: 'https://github.com/get-flashbacks/feedBack-plugin-metronome',
        commit: COMMIT_V1,
        archiveSha256: DIGEST_V1,
        installedAt: INSTALLED_AT,
        catalogRevision: CATALOG_REVISION,
        enabled: true,
        pinned: false,
    };
    assert.strictEqual(state.pinFor(legacy), null);
    assert.ok(!('previousVersions' in nextRecordAfterInstall(legacy, catalogEntry(), CATALOG_REVISION, INSTALLED_AT)));
});

test('pinning is a statement about what is installed now, and never mutates the record', () => {
    const rec = record();
    assert.deepStrictEqual(recordAfterPinChange(rec, true), { ...rec, pinned: true });
    assert.deepStrictEqual(recordAfterPinChange(rec, false), rec);
    assert.strictEqual(rec.pinned, false, 'the input record is untouched');

    const pinned = { ...rec, pinned: true };
    assert.strictEqual(recordAfterPinChange(pinned, true), pinned, 'pinning twice is a no-op');
    assert.strictEqual(recordAfterPinChange(pinned, false).pinned, false, 'unpinning is always allowed');
});

// ── Record after a rollback (issue #23, lifecycle 4/6) ────────────────────────

test('recordAfterRollback swaps the record to the restored version and keeps the displaced one as history', () => {
    // Simulate the state after an unconfirmed update: record claims 1.2.0, the
    // backup (1.0.0) is still on disk, and previousVersions[0] is the pin for
    // the version that was on disk before 1.2.0.
    const displaced = record({ version: '1.2.0' });
    const before = nextRecordAfterInstall(
        recordWithHistory('1.0.0', 1),
        catalogEntry({ version: '1.2.0' }),
        CATALOG_REVISION,
        INSTALLED_AT,
    );
    assert.strictEqual(before.version, '1.2.0');
    assert.deepStrictEqual(before.previousVersions.map(pin => pin.version), ['1.0.0', '0.1.0']);

    const restored = recordAfterRollback(before, '2026-10-08T01:00:00.000Z');
    assert.ok(restored, 'a pin exists to restore from');
    assert.strictEqual(restored.version, '1.0.0', 'the record now claims the restored version');
    assert.strictEqual(restored.installedAt, '2026-10-08T01:00:00.000Z');
    assert.strictEqual(restored.pinned, false, 'the pin was about the version that was installed, not the one restored');
    assert.strictEqual(restored.enabled, before.enabled, 'enabled state is carried over');
    assert.deepStrictEqual(restored.previousVersions.map(pin => pin.version), ['1.2.0', '0.1.0'], 'the rolled-back version joins history');
});

test('recordAfterRollback drops the record when the restored version cannot be recovered', () => {
    // A record with no history (e.g. first install recorded without a confirmed
    // activation) has no pin to restore from.
    const first = record({ version: '1.0.0' });
    assert.ok(!('previousVersions' in first));
    assert.strictEqual(recordAfterRollback(first, INSTALLED_AT), null);
});

test('recordAfterRollback re-pins through multiple rollback cycles', () => {
    // 1.0.0 → 1.1.0 (unconfirmed, backup kept) → restore to 1.0.0
    const afterFirstInstall = nextRecordAfterInstall(
        recordWithHistory('1.0.0', 1),
        catalogEntry({ version: '1.1.0' }),
        CATALOG_REVISION,
        INSTALLED_AT,
    );
    const rolledBack = recordAfterRollback(afterFirstInstall, '2026-10-08T01:00:00.000Z');
    assert.ok(rolledBack, 'a pin exists to restore from');
    assert.strictEqual(rolledBack.version, '1.0.0');
    assert.deepStrictEqual(rolledBack.previousVersions.map(pin => pin.version), ['1.1.0', '0.1.0']);

    // 1.0.0 (restored) → 1.2.0 (unconfirmed) → restore to 1.0.0 again
    const afterSecondInstall = nextRecordAfterInstall(rolledBack, catalogEntry({ version: '1.2.0' }), CATALOG_REVISION, INSTALLED_AT);
    const rolledBackAgain = recordAfterRollback(afterSecondInstall, '2026-10-08T02:00:00.000Z');
    assert.ok(rolledBackAgain, 'a pin exists to restore from');
    assert.strictEqual(rolledBackAgain.version, '1.0.0');
    assert.deepStrictEqual(rolledBackAgain.previousVersions.map(pin => pin.version), ['1.2.0', '1.1.0', '0.1.0']);
});

// ── User data ───────────────────────────────────────────────────────────────

test('a confirmed data delete is addressed inside the config dir only', () => {
    const configDir = path.join(path.sep === '\\' ? 'C:\\users\\x\\config' : '/home/x/config', 'feedBack');
    const paths = userDataPathsForPlugin(configDir, 'metronome', ['metronome.json', 'metronome.config', 'other', 'notes.txt']);

    assert.deepStrictEqual(paths, [
        path.join(configDir, 'plugin_data', 'metronome'),
        path.join(configDir, 'plugin_data', 'metronome.json'),
        path.join(configDir, 'plugin_data', 'metronome.config'),
        path.join(configDir, 'pip_packages', 'metronome'),
    ]);
    // Everything the app deletes on this path is under the config dir.
    for (const target of paths) {
        assert.ok(target.startsWith(path.join(configDir, path.sep)), target);
    }
    // The backend's own layout is left alone: only this plugin's own names.
    assert.ok(!paths.some(target => target.endsWith('other') || target.endsWith('notes.txt')));
});

test('a name from the filesystem cannot redirect a data delete out of the config dir', () => {
    const configDir = path.resolve('/home/x/config');
    for (const name of ['../evil', '/etc/passwd', '..', 'metronome/../../evil', 'metronome\\..\\..\\evil', 'metronometronome.json', '', 42, null]) {
        assert.deepStrictEqual(userDataPathsForPlugin(configDir, 'metronome', [name]).filter(target => target.includes('evil') || target.includes('passwd')), [], String(name));
    }
    for (const id of ['../metronome', 'metronome/../x', '/etc', '', 'METRONOME', 42, null, undefined]) {
        assert.deepStrictEqual(userDataPathsForPlugin(configDir, id), [], String(id));
    }
    // A relative config dir resolves first, so the same names stay contained.
    const relative = userDataPathsForPlugin('config', 'metronome', ['metronome.json']);
    for (const target of relative) assert.ok(path.isAbsolute(target), target);
});

// ── The view the Plugin Manager renders ─────────────────────────────────────

test('a copy parked on disk is disabled whatever the record claims', () => {
    const entry = catalogEntry();
    const stale = record({ version: '1.0.0' });

    const parked = lifecycleView({ entry, record: stale, disabled: true, canRollback: false });
    assert.strictEqual(parked.installed, true);
    assert.strictEqual(parked.enabled, false);
    assert.strictEqual(parked.disabled, true);
    assert.strictEqual(parked.updateStatus, 'disabled');
    assert.strictEqual(parked.updateAvailable, false, 'a disabled copy is never offered an update');
    assert.strictEqual(parked.recoveryInstructions, '', 'a disabled copy has no activation to recover');

    // No record but a directory on disk: still installed, still shown as disabled.
    const unrecorded = lifecycleView({ entry, record: null, disabled: true, canRollback: false });
    assert.strictEqual(unrecorded.installed, true);
    assert.strictEqual(unrecorded.installedVersion, null);
    assert.strictEqual(unrecorded.updateStatus, 'disabled');
    assert.strictEqual(unrecorded.recoveryInstructions, '', 'a disabled copy has no activation to recover');

    const available = lifecycleView({ entry, record: record({ version: '1.0.0' }), disabled: false, canRollback: true });
    assert.deepStrictEqual(
        { ...available, downgradeVersions: available.downgradeVersions.length },
        {
            installed: true,
            installedVersion: '1.0.0',
            enabled: true,
            pinned: false,
            updateStatus: 'available',
            updateAvailable: true,
            downgradeVersions: 0,
            disabled: false,
            canRollback: true,
            // A live copy with a backup gets "Restore previous" instructions.
            recoveryInstructions: 'Use "Restore previous" to roll back Metronome to the version installed before this one if this version does not work.',
        },
    );

    const catalogOnly = lifecycleView({ entry, record: null, disabled: false, canRollback: false });
    assert.deepStrictEqual(
        { ...catalogOnly, downgradeVersions: catalogOnly.downgradeVersions },
        {
            installed: false,
            installedVersion: null,
            enabled: true,
            pinned: false,
            updateStatus: 'not-installed',
            updateAvailable: false,
            downgradeVersions: [],
            disabled: false,
            canRollback: false,
            // An uninstalled copy has nothing on disk to recover.
            recoveryInstructions: '',
        },
    );
});

test('the view carries the downgrade versions the screen may offer', () => {
    const view = lifecycleView({
        entry: catalogEntry({ version: '1.3.0' }),
        record: recordWithHistory('1.3.0', 2),
        disabled: false,
        canRollback: true,
    });
    assert.deepStrictEqual(view.downgradeVersions, ['0.2.0', '0.1.0']);
    assert.strictEqual(view.updateStatus, 'current');
    // A backup is available, so the restore instruction is offered even though
    // downgrade history exists too — the backup is the shorter way back.
    assert.match(view.recoveryInstructions, /Restore previous/);
    assert.ok(!view.recoveryInstructions.includes('Downgrade'));
});

// ── Recovery instructions (issue #23, lifecycle 4/6) ──

test('recovery instructions point at rollback when a backup is kept', () => {
    const view = lifecycleView({
        entry: catalogEntry(),
        record: record({ version: '1.0.0' }),
        disabled: false,
        canRollback: true,
    });
    assert.match(
        view.recoveryInstructions,
        /Use "Restore previous" to roll back/,
        'a live copy with a backup is told to restore the previous version',
    );
});

test('recovery instructions fall back to downgrade when the backup was committed away', () => {
    const view = lifecycleView({
        entry: catalogEntry(),
        record: recordWithHistory('1.2.0', 2),
        disabled: false,
        canRollback: false,
    });
    assert.match(
        view.recoveryInstructions,
        /Use "Downgrade" to return/,
        'no backup, but history — the Downgrade buttons are the way back',
    );
    assert.ok(!view.recoveryInstructions.includes('Restore previous'), 'downgrade instructions do not mention restore');
});

test('recovery instructions are empty once every recovery path is gone', () => {
    // No backup, no history, but installed: nothing can restore an earlier version.
    const view = lifecycleView({
        entry: catalogEntry(),
        record: record({ version: '1.0.0' }),
        disabled: false,
        canRollback: false,
    });
    assert.strictEqual(view.recoveryInstructions, '', 'installed with nothing to roll back to or downgrade from');
});

test('recovery instructions are not offered for disabled or uninstalled copies', () => {
    const entry = catalogEntry();
    const disabled = lifecycleView({
        entry,
        record: record({ version: '1.0.0' }),
        disabled: true,
        canRollback: true,
    });
    assert.strictEqual(disabled.recoveryInstructions, '', 'a disabled copy is already parked');

    const uninstalled = lifecycleView({
        entry,
        record: null,
        disabled: false,
        canRollback: false,
    });
    assert.strictEqual(uninstalled.recoveryInstructions, '', 'no copy to recover');
});

// ── IPC arguments ───────────────────────────────────────────────────────────

test('an IPC argument is used only when it is already the value it claims to be', () => {
    assert.strictEqual(pluginIdFrom('metronome'), 'metronome');
    for (const bad of ['', '../etc', 'metronome/x', 'metronome\\x', 'METRONOME', 'metronome ', 42, null, undefined, ['metronome'], { id: 'metronome' }]) {
        assert.strictEqual(pluginIdFrom(bad), null, String(bad));
    }

    assert.strictEqual(versionFrom('1.2.0'), '1.2.0');
    assert.strictEqual(versionFrom('1.2.0-rc.1'), '1.2.0-rc.1');
    for (const bad of ['v1.2.0', '1.2', 'latest', '1.2.0 && rm -rf', 1.2, null, undefined, {}]) {
        assert.strictEqual(versionFrom(bad), null, String(bad));
    }
});

// Guard the assumption the tests above rest on: every pin the record still offers
// is one the installer's own gate would accept, so a downgrade cannot fail its
// way into an unchecked install.
test('every recorded pin is an entry the installer would accept', () => {
    const rec = recordWithHistory('1.2.0', 3);
    const offered = downgradeCandidates(rec);
    assert.strictEqual(offered.length, 3);
    for (const pin of offered) {
        assert.ok(installer.validateCatalogEntry(entryForPin(rec, pin, 'Metronome')), pin.version);
    }
});