'use strict';

// Lifecycle 5/6 (issue #24): the pure preflight rule that decides, before a
// desktop update is applied, whether each installed optional plugin will run on
// the target build, and what the catalog's lifecycle status
// (deprecated / withdrawn / security-blocked) means for it. Also pins the
// install-provenance check: a catalog entry the desktop would install is
// sourced where its trust class says it is — get-flashbacks sources come from a
// get-flashbacks fork, never an arbitrary upstream.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { loadTs, ROOT } = require('./_load-ts');
const {
    entryStatus,
    isEntryBlocked,
    blockedReason,
    canReenablePlugin,
    preflightForUpdate,
    isTrustedCatalogSource,
    archiveOriginOwner,
} = loadTs('src/main/plugin-preflight.ts');
const {
    compatibilityFor,
    PLUGIN_API_VERSION,
} = loadTs('src/main/plugin-compat.ts');
const { loadCatalog } = loadTs('src/main/plugin-installer.ts');

function entry(overrides) {
    return Object.assign({
        id: 'metronome',
        installDir: 'metronome',
        name: 'Metronome',
        description: 'A click track.',
        repository: 'https://github.com/get-flashbacks/feedback-plugin-metronome',
        version: '1.2.0',
        commit: 'a'.repeat(40),
        archiveSha256: 'b'.repeat(64),
        source: 'get-flashbacks',
        category: 'tools',
        instruments: [],
        stability: 'stable',
        compatibility: { minCoreVersion: '0.3.0', minPluginApiVersion: '1' },
        dependencies: [],
        conflicts: [],
        size: { downloadBytes: 100, installedBytes: 200 },
        selection: { tier: 'optional', defaultSelected: false },
    }, overrides);
}

function record(overrides) {
    return Object.assign({
        id: 'metronome',
        installDir: 'metronome',
        version: '1.2.0',
        repository: 'https://github.com/get-flashbacks/feedback-plugin-metronome',
        commit: 'a'.repeat(40),
        archiveSha256: 'b'.repeat(64),
        installedAt: '2026-01-01T00:00:00.000Z',
        catalogRevision: 'c'.repeat(64),
        source: 'get-flashbacks',
        downloadBytes: 100,
        installedBytes: 200,
        enabled: true,
        pinned: false,
    }, overrides);
}

test('entryStatus defaults to active and reads the catalog status field', () => {
    assert.equal(entryStatus(entry({})), 'active');
    assert.equal(entryStatus(entry({ status: 'deprecated' })), 'deprecated');
    assert.equal(entryStatus(entry({ status: 'withdrawn' })), 'withdrawn');
    assert.equal(entryStatus(entry({ status: 'security-blocked' })), 'security-blocked');
    // Unknown / malformed values degrade to active rather than inventing a status.
    assert.equal(entryStatus(entry({ status: 'removed' })), 'active');
    assert.equal(entryStatus(entry({ status: 42 })), 'active');
    assert.equal(entryStatus(entry({ status: null })), 'active');
});

test('isEntryBlocked flags withdrawn and security-blocked, not deprecated', () => {
    assert.equal(isEntryBlocked(entry({ status: 'withdrawn' })), true);
    assert.equal(isEntryBlocked(entry({ status: 'security-blocked' })), true);
    assert.equal(isEntryBlocked(entry({ status: 'deprecated' })), false);
    assert.equal(isEntryBlocked(entry({})), false);
});

test('blockedReason names the right status and is null for non-blocked entries', () => {
    assert.equal(
        blockedReason(entry({ status: 'withdrawn' })),
        'Metronome has been withdrawn and has been disabled on this version of fee[dB]ack.',
    );
    assert.equal(
        blockedReason(entry({ status: 'security-blocked' })),
        'Metronome is security-blocked on this version of fee[dB]ack and has been disabled.',
    );
    assert.equal(blockedReason(entry({ status: 'deprecated' })), null);
    assert.equal(blockedReason(entry({})), null);
});

test('canReenablePlugin denies hard-blocked entries but allows deprecated ones', () => {
    assert.equal(canReenablePlugin(entry({ status: 'withdrawn' })), false);
    assert.equal(canReenablePlugin(entry({ status: 'security-blocked' })), false);
    assert.equal(canReenablePlugin(entry({ status: 'deprecated' })), true);
    assert.equal(canReenablePlugin(entry({})), true);
});

test('preflight disables a compatible plugin that is security-blocked', () => {
    const target = { coreVersion: '9.0.0', pluginApiVersion: PLUGIN_API_VERSION };
    const report = preflightForUpdate([entry({ status: 'security-blocked' })], new Map([['metronome', record()]]), target);
    assert.equal(report.needsAttention, true);
    assert.equal(report.verdicts.length, 1);
    const v = report.verdicts[0];
    assert.equal(v.status, 'security-blocked');
    assert.equal(v.action, 'disable');
    assert.equal(v.targetCompat.ok, true);
    assert.equal(v.explanation, 'Metronome is security-blocked on this version of fee[dB]ack and has been disabled.');
});

test('preflight disables a compatible plugin that is withdrawn', () => {
    const target = { coreVersion: '9.0.0', pluginApiVersion: PLUGIN_API_VERSION };
    const report = preflightForUpdate([entry({ status: 'withdrawn' })], new Map([['metronome', record()]]), target);
    const v = report.verdicts[0];
    assert.equal(v.action, 'disable');
    assert.equal(v.status, 'withdrawn');
    assert.equal(v.explanation, 'Metronome has been withdrawn and has been disabled on this version of fee[dB]ack.');
});

test('preflight disables an incompatible plugin with the compatibility reason', () => {
    // minCoreVersion demands a build newer than the target.
    const entry = makeIncompatible();
    const target = { coreVersion: '0.2.0', pluginApiVersion: PLUGIN_API_VERSION };
    const report = preflightForUpdate([entry], new Map([['metronome', record({ version: '1.2.0' })]]), target);
    const v = report.verdicts[0];
    assert.equal(v.action, 'disable');
    assert.equal(v.targetCompat.ok, false);
    assert.equal(v.targetCompat.reason, compatibilityFor(entry, target).reason);
    assert.equal(v.explanation, compatibilityFor(entry, target).reason);
});

function makeIncompatible() {
    return entry({ compatibility: { minCoreVersion: '0.3.0', minPluginApiVersion: '1' } });
}

test('preflight keeps a compatible, active plugin and a deprecated one', () => {
    const target = { coreVersion: '0.3.0', pluginApiVersion: PLUGIN_API_VERSION };
    const report = preflightForUpdate(
        [entry({}), entry({ id: 'dep', installDir: 'dep', status: 'deprecated' })],
        new Map([
            ['metronome', record()],
            ['dep', record({ id: 'dep', installDir: 'dep', version: '0.1.0' })],
        ]),
        target,
    );
    assert.equal(report.needsAttention, false);
    assert.equal(report.verdicts.length, 2);
    const byId = Object.fromEntries(report.verdicts.map(v => [v.id, v]));
    assert.equal(byId.metronome.action, 'keep');
    assert.equal(byId.metronome.explanation, '');
    assert.equal(byId.dep.action, 'keep');
    assert.ok(byId.dep.explanation.includes('deprecated'));
});

test('preflight skips installed plugins the catalog no longer carries', () => {
    // A legacy copy with no catalog entry is not part of the update surface.
    const target = { coreVersion: '0.3.0', pluginApiVersion: PLUGIN_API_VERSION };
    const report = preflightForUpdate(
        [entry({})],
        new Map([['orphan', record({ id: 'orphan', installDir: 'orphan' })]]),
        target,
    );
    assert.equal(report.verdicts.length, 0);
    assert.equal(report.needsAttention, false);
});

test('archiveOriginOwner reads the repository owner the archive is fetched from', () => {
    assert.equal(archiveOriginOwner(entry({})), 'get-flashbacks');
    assert.equal(archiveOriginOwner(entry({ repository: 'https://github.com/upstream/proj' })), 'upstream');
    assert.equal(archiveOriginOwner({ ...entry({}), repository: 'not-a-url' }), null);
});

test('isTrustedCatalogSource keeps the source class matched to its owner', () => {
    // get-flashbacks entries must download from a get-flashbacks fork; there is
    // no upstream fork of a fork to fall back to, so a wrong owner is untrusted.
    assert.equal(isTrustedCatalogSource(entry({})), true);
    assert.equal(isTrustedCatalogSource(entry({ repository: 'https://github.com/upstream/proj' })), false);
    assert.equal(isTrustedCatalogSource(entry({ source: 'upstream-official' })), false);
    assert.equal(isTrustedCatalogSource(entry({ source: 'upstream-official', repository: 'https://github.com/got-feedback/proj' })), true);
    // reviewed-community is anchored to a record (commit + sha), not an owner.
    assert.equal(isTrustedCatalogSource(entry({ source: 'reviewed-community', repository: 'https://github.com/anyone/proj' })), true);
});

test('the shipped catalog installs every entry from a get-flashbacks fork unless no fork exists', () => {
    // The desktop installs a get-flashbacks source only from a get-flashbacks
    // repository; upstream-official is the only class that may name another owner
    // (got-feedback), and that is the documented "no get-flashbacks fork" path.
    const catalog = loadCatalog(path.join(ROOT, 'resources', 'plugin-catalog.json'));
    for (const e of catalog.entries) {
        assert.equal(isTrustedCatalogSource(e), true, `${e.name} (${e.source}) is not trusted`);
        const owner = archiveOriginOwner(e);
        if (e.source === 'get-flashbacks') {
            assert.equal(owner, 'get-flashbacks', `${e.name} is catalogued as get-flashbacks but its archive is not on get-flashbacks`);
        } else if (e.source === 'upstream-official') {
            assert.equal(owner, 'got-feedback', `${e.name} is upstream-official and must resolve to got-feedback`);
        }
    }
});
