// Compatibility of a catalog entry against the build showing it (issue #16,
// catalog UI 2/5). plugin-compat.ts turns the entry's declared version bounds
// into the verdict the browse card shows: a requirements line when it fits, a
// sentence saying why not when it does not. Pure by design — no electron, no
// disk — so this suite pins the rule itself.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { loadTs, ROOT } = require('./_load-ts');
const { PLUGIN_API_VERSION, compareBound, compatibilityFor } = loadTs('src/main/plugin-compat.ts');

const BUILD = { coreVersion: '0.3.0', pluginApiVersion: PLUGIN_API_VERSION };

function entry(overrides) {
    return {
        name: 'Example',
        compatibility: { minCoreVersion: '0.3.0', minPluginApiVersion: '1' },
        ...overrides,
    };
}

// ── compareBound ─────────────────────────────────────────────────────

test('compareBound orders dotted versions numerically, not lexicographically', () => {
    assert.equal(compareBound('0.3.0', '0.3.0'), 0);
    // "0.10.0" would sort before "0.3.0" as plain text and reject a newer build.
    assert.equal(compareBound('0.3.0', '0.10.0'), -1);
    assert.equal(compareBound('0.10.0', '0.3.0'), 1);
    // The bare plugin-API generation: no minor or patch segments at all.
    assert.equal(compareBound('1', '2'), -1);
    assert.equal(compareBound('2', '1'), 1);
    // A missing segment counts as zero, so padding is irrelevant.
    assert.equal(compareBound('1', '1.0'), 0);
    assert.equal(compareBound('1.0.0', '1'), 0);
    assert.equal(compareBound('1.1.0', '1'), 1);
    assert.equal(compareBound('0.3', '0.3.0'), 0);
    // Differently spelled but numerically equal segments are equal in both
    // directions — a padded bound must not compare greater than itself.
    assert.equal(compareBound('0.3.0', '0.03.0'), 0);
    assert.equal(compareBound('0.03.0', '0.3.0'), 0);
});

// ── compatibilityFor: a fit ──────────────────────────────────────────

test('a matching declaration reports the requirement, with no verdict of its own', () => {
    const view = compatibilityFor(entry(), BUILD);
    assert.equal(view.ok, true);
    assert.equal(view.reason, null);
    assert.equal(view.requirements, 'fee[dB]ack core 0.3.0 or newer, plugin API 1 or newer');
});

test('bounds compose into one requirements phrase: minimum, maximum, and both', () => {
    assert.equal(
        compatibilityFor(entry({ compatibility: { maxCoreVersion: '0.9.0' } }), BUILD).requirements,
        'fee[dB]ack core 0.9.0 or earlier'
    );
    assert.equal(
        compatibilityFor(entry({
            compatibility: { minCoreVersion: '0.2.0', maxCoreVersion: '0.9.0' },
        }), BUILD).requirements,
        'fee[dB]ack core 0.2.0 to 0.9.0'
    );
    // Only one bound declared: the other half of the phrase stays absent rather
    // than being invented.
    assert.equal(
        compatibilityFor(entry({ compatibility: { minPluginApiVersion: '2' } }), BUILD).requirements,
        'plugin API 2 or newer'
    );
});

test('a missing or damaged declaration is not an incompatibility', () => {
    for (const compatibility of [undefined, null, '', '0.3.0', []]) {
        const view = compatibilityFor(entry({ compatibility }), BUILD);
        assert.equal(view.ok, true, `no verdict for compatibility=${JSON.stringify(compatibility)}`);
        assert.equal(view.requirements, '');
        assert.equal(view.reason, null);
    }
});

// ── compatibilityFor: a mismatch ─────────────────────────────────────

test('a core below the minimum says which version is needed and which ships', () => {
    const view = compatibilityFor(
        entry({ compatibility: { minCoreVersion: '0.4.0' } }),
        BUILD,
    );
    assert.equal(view.ok, false);
    assert.equal(view.reason, 'Example needs fee[dB]ack core 0.4.0 or newer; this build ships 0.3.0.');
    // The requirement is still stated, so the card can show both halves.
    assert.equal(view.requirements, 'fee[dB]ack core 0.4.0 or newer');
});

test('a core above a declared maximum is refused too', () => {
    const view = compatibilityFor(
        entry({ compatibility: { maxCoreVersion: '0.2.0' } }),
        { coreVersion: '0.3.0', pluginApiVersion: '1' },
    );
    assert.equal(view.ok, false);
    assert.equal(view.reason, 'Example supports fee[dB]ack core up to 0.2.0; this build ships 0.3.0.');
});

test('the plugin-API bounds are judged against the API this build provides', () => {
    const needs = compatibilityFor(
        entry({ compatibility: { minPluginApiVersion: '2' } }),
        BUILD,
    );
    assert.equal(needs.ok, false);
    assert.equal(needs.reason, 'Example needs plugin API 2 or newer; this build provides 1.');

    const old = compatibilityFor(
        entry({ compatibility: { maxPluginApiVersion: '1' } }),
        { coreVersion: '0.3.0', pluginApiVersion: '2' },
    );
    assert.equal(old.ok, false);
    assert.equal(old.reason, 'Example supports plugin API up to 1; this build provides 2.');
});

test('an unnamed entry still gets a readable reason', () => {
    const view = compatibilityFor(
        { compatibility: { minCoreVersion: '0.4.0' } },
        BUILD,
    );
    assert.equal(view.ok, false);
    assert.equal(view.reason, 'This plugin needs fee[dB]ack core 0.4.0 or newer; this build ships 0.3.0.');
});

test('the core bound is checked before the API bound, so the reason names one fix', () => {
    const view = compatibilityFor(
        entry({ compatibility: { minCoreVersion: '0.4.0', minPluginApiVersion: '2' } }),
        BUILD,
    );
    assert.equal(view.ok, false);
    assert.equal(view.reason, 'Example needs fee[dB]ack core 0.4.0 or newer; this build ships 0.3.0.');
});

// ── The declaration this build carries ───────────────────────────────

test('this build declares a plugin API generation', () => {
    // The backend that serves the API is not in this repository, so nothing can
    // probe it: the desktop declares the level it ships. Pin it as a bare
    // generation string — the form the shipped entries declare.
    assert.equal(PLUGIN_API_VERSION, '1');
});

test('every entry in the shipped catalog fits the build that ships it', () => {
    // The strongest statement the rule can make about real data: the catalog on
    // disk, judged against this package's own version, is installable here.
    // A catalog bumped past the app's version would fail this before a user ever
    // saw a red card.
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'resources', 'plugin-catalog.json'), 'utf8'));
    assert.ok(catalog.entries.length > 0, 'the bundled catalog should ship entries');
    for (const shipped of catalog.entries) {
        const view = compatibilityFor(shipped, {
            coreVersion: pkg.version,
            pluginApiVersion: PLUGIN_API_VERSION,
        });
        assert.equal(
            view.ok, true,
            `${shipped.id} should fit this build: ${view.reason || ''}`
        );
        assert.ok(view.requirements, `${shipped.id} should state what it requires`);
    }
});
