// First-run guided plugin selection (issue #5).
//
// A fresh install does not need every optional plugin, so the first launch
// offers a short wizard: pick instruments and features, review the resolved
// selection (dependencies included), then download everything in one batch
// with progress and cancellation. The batch installer restarts the backend
// exactly once at the end.
//
// The wizard is its own local window (src/main/wizard.html + wizard.js) rather
// than a renderer screen because it has to appear before the user has navigated
// anywhere in the app — and because "skip" must leave a fully working app. It
// talks to the same Plugin Manager catalog/install surface the rest of the app
// uses, but through its own minimal bridge (wizard-preload.ts).
//
// State lives in the desktop config (see soundfont-manager.ts): `completed`
// keeps the wizard from reappearing, `pendingIds` is what an interrupted run
// still owes so reopening resumes instead of starting over. What each of those
// transitions means is pure logic in plugin-setup-state.ts, selecting and
// resolving is pure logic in plugin-selection.ts — this module only supplies
// catalog state, persists progress and drives the window.

import { app, BrowserWindow, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import {
    IPC_PLUGIN_WIZARD_FINISH,
    IPC_PLUGIN_WIZARD_GET_STATE,
    IPC_PLUGIN_WIZARD_INSTALL,
    IPC_PLUGIN_WIZARD_OPEN,
    IPC_PLUGIN_WIZARD_PREVIEW,
    IPC_PLUGIN_WIZARD_RESOLVE,
} from './ipc-channels';
import { catalogSelectionEntries, installFromCatalog, isInstallBusy, planCatalogInstall } from './plugin-manager';
import {
    SelectionEntry,
    WizardAnswers,
    WizardQuestions,
    buildWizardQuestions,
    previewSelection,
    recommendIds,
    resolveSelection,
} from './plugin-selection';
import { SetupState, isOnboardingNeeded, readSetupState, shouldAutoOpenWizard, stateAfterClose } from './plugin-setup-state';
import { getDesktopConfig, setDesktopConfig } from './soundfont-manager';

// ── Persisted onboarding state ────────────────────────────────────────────

/** The transitions themselves are pure and live in plugin-setup-state.ts. */
function readSetup(): SetupState {
    return readSetupState(getDesktopConfig().pluginSetup);
}

function markCompleted(pendingIds: string[] = []): void {
    const cfg = getDesktopConfig().pluginSetup ?? {};
    setDesktopConfig({
        pluginSetup: {
            ...cfg,
            completed: true,
            completedAt: new Date().toISOString(),
            pendingIds,
        },
    });
}

/** Record a selection that is not fully installed, so a resume knows what to finish. */
function markPending(ids: string[]): void {
    const cfg = getDesktopConfig().pluginSetup ?? {};
    setDesktopConfig({ pluginSetup: { ...cfg, completed: false, pendingIds: ids } });
}

// ── Wizard state ──────────────────────────────────────────────────────────

export interface WizardState {
    /** True while the wizard has never been finished or skipped. */
    firstRun: boolean;
    /** True when a previous run was interrupted and this session continues it. */
    resume: boolean;
    questions: WizardQuestions;
    entries: SelectionEntry[];
    /** Checked by default with no answers given (essential + catalog defaults). */
    recommended: string[];
    /** Pre-checked selection when resuming an interrupted run. */
    selection: string[];
    /** True while a batch install is running, so the UI can lock itself. */
    busy: boolean;
}

function wizardState(): WizardState {
    const entries = catalogSelectionEntries();
    const setup = readSetup();
    const answers: WizardAnswers = { instruments: [], categories: [] };
    return {
        firstRun: !setup.completed,
        resume: !setup.completed && setup.pendingIds.length > 0,
        questions: buildWizardQuestions(entries),
        entries,
        recommended: recommendIds(entries, answers),
        selection: setup.pendingIds.filter(id => entries.some(e => e.id === id)),
        busy: isInstallBusy(),
    };
}

// ── Install ───────────────────────────────────────────────────────────────

async function runInstall(ids: unknown): Promise<{ success: boolean; message: string; results: unknown[] }> {
    // Re-resolved in main, the same way the Plugin Manager resolves its own
    // selection: the wizard never gets to name a plugin outside the catalog,
    // bypass a dependency, or force a conflicting pair through.
    const { ids: resolved, outstanding: todo } = planCatalogInstall(ids);
    // Resume path: a plugin already on disk at its pinned version is skipped,
    // so re-running an interrupted setup never reinstalls finished work.
    if (resolved.length > 0 && todo.length === 0) {
        markCompleted([]);
        return { success: true, message: 'Everything in this selection is already installed.', results: [] };
    }
    if (todo.length === 0) {
        return { success: true, message: 'Select at least one plugin to install.', results: [] };
    }
    markPending(todo);
    const outcome = await installFromCatalog(todo);
    const installed = new Set(
        (outcome.results as Array<{ id?: unknown; success?: boolean }>)
            .filter(r => r && r.success === true)
            .map(r => String(r.id)),
    );
    const remaining = todo.filter(id => !installed.has(id));
    if (remaining.length === 0) {
        // Success — or a failure that left nothing selected behind. Either way
        // the user is inside the app and can fix a broken plugin from the
        // Plugin Manager, which is where rollback lives.
        markCompleted([]);
        return outcome;
    }
    markPending(remaining);
    return outcome;
}

// ── Window ────────────────────────────────────────────────────────────────

let wizardWindow: BrowserWindow | null = null;
let getMainWindow: () => BrowserWindow | null = () => null;
let installRunning = false;
// Set once the app is on its way out — a quit, or the renderer startup giving up
// (failRendererStartup calls app.quit()). Either way the wizard window goes with
// it, so its `closed` handler must not read the close as a decision.
let goingAway = false;

/**
 * Bring up the wizard window, focusing the existing one if it is already open.
 * Returns false when the wizard assets are missing (a build that forgot to copy
 * them) so callers can fall back to the Plugin Manager instead of opening a
 * blank window.
 */
export function openWizardWindow(): boolean {
    if (wizardWindow && !wizardWindow.isDestroyed()) {
        wizardWindow.show();
        wizardWindow.focus();
        return true;
    }
    const page = path.join(__dirname, 'wizard.html');
    if (!fs.existsSync(page)) {
        console.error('[plugin-wizard] wizard.html is missing from the build; the Plugin Manager still offers the catalog');
        return false;
    }
    const parent = getMainWindow();
    wizardWindow = new BrowserWindow({
        width: 760,
        height: 680,
        minWidth: 640,
        minHeight: 560,
        // Parented so it stays with the app, but not modal: the user may want
        // to look at (and keep working in) the app while reading the list.
        ...(parent && !parent.isDestroyed() ? { parent } : {}),
        title: 'fee[dB]ack — plugin setup',
        backgroundColor: '#0f172a',
        autoHideMenuBar: true,
        webPreferences: {
            // Its own minimal bridge (wizard-preload.ts), not the full desktop
            // one: this document only needs catalog state and the install
            // batch it started, so the audio engine and the destructive
            // maintenance actions stay out of its reach.
            preload: path.join(__dirname, 'wizard-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });
    wizardWindow.setMenuBarVisibility(false);
    // The page is a local, static document: deny pop-ups and any navigation,
    // so it can never end up rendering remote content with the desktop bridge.
    wizardWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    wizardWindow.webContents.on('will-navigate', (event) => event.preventDefault());
    wizardWindow.once('ready-to-show', () => {
        if (wizardWindow && !wizardWindow.isDestroyed()) wizardWindow.show();
    });
    wizardWindow.on('closed', () => {
        wizardWindow = null;
        // A close the user made themselves is the skip path: stop asking on
        // every launch. It is also the only escape from a resume whose batch
        // keeps failing, so `pendingIds` must not survive to re-prompt forever.
        // A close the app caused is not a decision — see `goingAway`.
        const next = stateAfterClose(readSetup(), { installRunning, goingAway });
        if (next) markCompleted(next.pendingIds);
    });
    wizardWindow.loadFile(page).catch((e: unknown) => {
        console.error('[plugin-wizard] could not load the wizard page', e);
    });
    return true;
}

export function closeWizardWindow(): void {
    if (wizardWindow && !wizardWindow.isDestroyed()) wizardWindow.close();
}

// ── IPC ───────────────────────────────────────────────────────────────────

export interface PluginWizardDeps {
    getWindow: () => BrowserWindow | null;
    /**
     * "Is this URL exactly the renderer origin?" — the predicate createWindow
     * uses for its own paint check, handed over rather than reimplemented so the
     * two can never drift apart.
     */
    isRendererOrigin: (url: string) => boolean;
}

export function initPluginWizard(deps: PluginWizardDeps): void {
    const { getWindow, isRendererOrigin } = deps;
    getMainWindow = getWindow;

    ipcMain.handle(IPC_PLUGIN_WIZARD_OPEN, () => ({ success: openWizardWindow() }));

    ipcMain.handle(IPC_PLUGIN_WIZARD_GET_STATE, () => wizardState());

    ipcMain.handle(IPC_PLUGIN_WIZARD_PREVIEW, (_event, answers: unknown) => {
        const entries = catalogSelectionEntries();
        const preview = previewSelection(entries, answers);
        return { recommended: preview.recommended, plan: preview.plan };
    });

    ipcMain.handle(IPC_PLUGIN_WIZARD_RESOLVE, (_event, ids: unknown) => {
        const entries = catalogSelectionEntries();
        return { plan: resolveSelection(entries, Array.isArray(ids) ? ids : []) };
    });

    ipcMain.handle(IPC_PLUGIN_WIZARD_INSTALL, async (_event, ids: unknown) => {
        if (installRunning) {
            return { success: false, message: 'The setup is already running.', results: [] };
        }
        installRunning = true;
        try {
            return await runInstall(ids);
        } finally {
            installRunning = false;
        }
    });

    ipcMain.handle(IPC_PLUGIN_WIZARD_FINISH, (_event, payload: unknown) => {
        const skipped = typeof payload === 'object' && payload !== null
            && (payload as { skipped?: unknown }).skipped === true;
        // Skipping is a decision, not a failure: the minimal app is fully
        // functional, so onboarding must not come back on the next launch.
        markCompleted([]);
        closeWizardWindow();
        return { success: true, skipped };
    });

    // First run: wait for the app window to paint before putting the wizard on
    // top of it, so the two never fight over focus during startup.
    app.on('before-quit', () => { goingAway = true; });
    const main = getWindow();
    if (main && !main.isDestroyed()) {
        // Closing the main window takes the (parented) wizard with it, and the
        // app only turns that into a quit afterwards — so `close` is the signal
        // here, not `before-quit`.
        main.on('close', () => { goingAway = true; });
        // `.on` plus the origin gate, exactly like the sibling handler in
        // createWindow: Chromium fires did-finish-load for its built-in error
        // pages too, and main.ts re-issues loadURL on every did-fail-load retry,
        // so the event that lands first may be an error page committing with the
        // real paint still a retry away.
        main.webContents.on('did-finish-load', () => {
            const url = main.webContents.getURL() || '';
            if (!shouldAutoOpenWizard(url, { isRendererOrigin, onboardingNeeded: isOnboardingNeeded(readSetup()) })) return;
            try {
                openWizardWindow();
            } catch (e) {
                console.error('[plugin-wizard] could not open the first-run wizard', e);
            }
        });
    }
}
