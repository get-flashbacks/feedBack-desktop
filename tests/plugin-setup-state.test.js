'use strict';

// Onboarding state machine for the first-run setup wizard (issue #5): when the
// wizard may open, and what closing its window means. Pure logic, so no
// Electron needed — these are the transitions plugin-wizard.ts feeds the
// desktop config into.

const assert = require('node:assert');
const test = require('node:test');
const { loadTs } = require('./_load-ts');

const setup = loadTs('src/main/plugin-setup-state.ts');

const firstRun = { completed: false, pendingIds: [] };
/** What an interrupted run leaves behind: a batch that did not fully land. */
const interrupted = { completed: false, pendingIds: ['metronome', 'piano'] };
const finished = { completed: true, pendingIds: [] };

// ── Reading the persisted state ───────────────────────────────────────────

test('a missing or damaged config entry reads as a first run', () => {
    assert.deepStrictEqual(setup.readSetupState(undefined), firstRun);
    assert.deepStrictEqual(setup.readSetupState(null), firstRun);
    assert.deepStrictEqual(setup.readSetupState('nonsense'), firstRun);
    assert.deepStrictEqual(setup.readSetupState({}), firstRun);
    // Only a literal `true` counts as finished.
    assert.deepStrictEqual(setup.readSetupState({ completed: 'yes' }), firstRun);
});

test('pendingIds survives anything that is not a string id', () => {
    assert.deepStrictEqual(
        setup.readSetupState({ completed: false, pendingIds: ['metronome', 7, null, 'piano'] }),
        { completed: false, pendingIds: ['metronome', 'piano'] },
    );
    assert.deepStrictEqual(setup.readSetupState({ pendingIds: 'metronome' }), firstRun);
});

test('onboarding is needed until the wizard was finished or skipped', () => {
    assert.strictEqual(setup.isOnboardingNeeded(firstRun), true);
    // A pending selection is still a first run — that is what the resume is for.
    assert.strictEqual(setup.isOnboardingNeeded(interrupted), true);
    assert.strictEqual(setup.isOnboardingNeeded(finished), false);
});

// ── Closing the wizard window ─────────────────────────────────────────────

test('a close the user made is a skip, even with work still pending', () => {
    // The escape hatch for a resume whose batch keeps failing: without this the
    // wizard re-prompts on every launch and nothing on that screen says so.
    assert.deepStrictEqual(
        setup.stateAfterClose(interrupted, { installRunning: false, goingAway: false }),
        finished,
    );
    assert.deepStrictEqual(
        setup.stateAfterClose(firstRun, { installRunning: false, goingAway: false }),
        finished,
    );
});

test('a close the app caused is not a decision', () => {
    // `failRendererStartup` calls app.quit(), so the wizard window goes with the
    // app. Recording that as a skip would consume onboarding the user never
    // finished, on a launch that never worked.
    assert.strictEqual(setup.stateAfterClose(firstRun, { installRunning: false, goingAway: true }), null);
    assert.strictEqual(setup.stateAfterClose(interrupted, { installRunning: false, goingAway: true }), null);
});

test('a close during a batch leaves the run to record its own outcome', () => {
    assert.strictEqual(setup.stateAfterClose(firstRun, { installRunning: true, goingAway: false }), null);
    assert.strictEqual(setup.stateAfterClose(interrupted, { installRunning: true, goingAway: false }), null);
});

test('a close after the wizard was already answered writes nothing', () => {
    // IPC_PLUGIN_WIZARD_FINISH marks it complete and then closes the window.
    assert.strictEqual(setup.stateAfterClose(finished, { installRunning: false, goingAway: false }), null);
});

// ── The first-run trigger ─────────────────────────────────────────────────

const renderer = (url) => url.startsWith('http://127.0.0.1:8000');
const autoOpen = (url, onboardingNeeded = true) =>
    setup.shouldAutoOpenWizard(url, { isRendererOrigin: renderer, onboardingNeeded });

test('the wizard opens over the renderer, not over an error page', () => {
    assert.strictEqual(autoOpen('http://127.0.0.1:8000/'), true);
    // Chromium commits a built-in error page and fires did-finish-load for it,
    // with a null origin — and main.ts re-issues loadURL on every retry, so this
    // is the event that lands first on a slow first start.
    assert.strictEqual(autoOpen('chrome-error://chromewebdata/'), false);
    assert.strictEqual(autoOpen(''), false);
    // Another local service on a different port is not our renderer either.
    assert.strictEqual(autoOpen('http://127.0.0.1:9999/'), false);
});

test('once onboarding is answered the trigger stays quiet on later loads', () => {
    assert.strictEqual(autoOpen('http://127.0.0.1:8000/', false), false);
});