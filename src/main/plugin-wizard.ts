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
// reuses the ordinary preload bridge, so it can talk to the same Plugin Manager
// catalog/install surface the rest of the app uses.
//
// State lives in the desktop config (see soundfont-manager.ts): `completed`
// keeps the wizard from reappearing, `pendingIds` is what an interrupted run
// still owes so reopening resumes instead of starting over.
//
// Selecting and resolving is pure logic in plugin-selection.ts — this module
// only supplies catalog state, persists progress and drives the window.

import { BrowserWindow, ipcMain } from 'electron';
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
import { installFromCatalog, isInstallBusy, listCatalog } from './plugin-manager';
import {
    SelectionEntry,
    WizardAnswers,
    WizardQuestions,
    buildWizardQuestions,
    previewSelection,
    recommendIds,
    resolveSelection,
    selectableEntries,
    toSelectionEntries,
} from './plugin-selection';
import { getDesktopConfig, setDesktopConfig } from './soundfont-manager';

// ── Persisted onboarding state ────────────────────────────────────────────

interface SetupState {
    completed: boolean;
    pendingIds: string[];
}

function readSetupState(): SetupState {
    const cfg = getDesktopConfig().pluginSetup ?? {};
    return {
        completed: cfg.completed === true,
        pendingIds: Array.isArray(cfg.pendingIds) ? cfg.pendingIds.filter(id => typeof id === 'string') : [],
    };
}

/** First run is "the wizard has never been finished or explicitly skipped". */
export function isOnboardingNeeded(): boolean {
    return !readSetupState().completed;
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

// ── Catalog view ──────────────────────────────────────────────────────────

/**
 * The catalog as the wizard sees it: metadata plus live install state. A
 * missing or damaged catalog yields an empty list — "nothing to offer", never
 * a failed launch.
 */
function selectionEntries(): SelectionEntry[] {
    try {
        return toSelectionEntries(listCatalog());
    } catch (e) {
        console.error('[plugin-wizard] catalog unavailable', e);
        return [];
    }
}

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
    const entries = selectionEntries();
    const setup = readSetupState();
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

/** Ids that still need work: everything not already installed at its pinned version. */
function outstandingIds(entries: SelectionEntry[], ids: string[]): string[] {
    return ids.filter(id => {
        const entry = entries.find(e => e.id === id);
        if (!entry) return false;
        // A bundled core plugin ships with the app; the installer refuses to
        // place a second copy over it, so it is never "outstanding".
        if (entry.bundled) return false;
        return entry.installedVersion !== entry.version;
    });
}

/**
 * Re-resolve a renderer-supplied selection in main before acting on it: the
 * wizard never gets to name a plugin outside the catalog, bypass a dependency,
 * or force a conflicting pair through.
 */
function planFor(ids: unknown): { entries: SelectionEntry[]; ids: string[] } {
    const entries = selectionEntries();
    const requested = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
    const plan = resolveSelection(entries, requested);
    // Locked (essential) entries are part of the app, not a choice: keep them
    // in the set regardless of what the UI sent.
    const locked = selectableEntries(entries).filter(e => e.tier === 'essential').map(e => e.id);
    const resolved = resolveSelection(entries, [...locked, ...plan.ids]);
    return { entries, ids: resolved.ids };
}

async function runInstall(ids: unknown): Promise<{ success: boolean; message: string; results: unknown[] }> {
    const { entries, ids: resolved } = planFor(ids);
    // Resume path: a plugin already on disk at its pinned version is skipped,
    // so re-running an interrupted setup never reinstalls finished work.
    const todo = outstandingIds(entries, resolved);
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
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            // sandbox must be false so the preload can require('electron')
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
        // Closing without finishing is the skip path: stop asking on every
        // launch. An interrupted run keeps `pendingIds`, so it stays unfinished
        // and the next launch resumes instead.
        if (!installRunning) {
            const setup = readSetupState();
            if (setup.pendingIds.length === 0 && !setup.completed) markCompleted([]);
        }
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

export function initPluginWizard(getWindow: () => BrowserWindow | null): void {
    getMainWindow = getWindow;

    ipcMain.handle(IPC_PLUGIN_WIZARD_OPEN, () => ({ success: openWizardWindow() }));

    ipcMain.handle(IPC_PLUGIN_WIZARD_GET_STATE, () => wizardState());

    ipcMain.handle(IPC_PLUGIN_WIZARD_PREVIEW, (_event, answers: unknown) => {
        const entries = selectionEntries();
        const preview = previewSelection(entries, answers);
        return { recommended: preview.recommended, plan: preview.plan };
    });

    ipcMain.handle(IPC_PLUGIN_WIZARD_RESOLVE, (_event, ids: unknown) => {
        const entries = selectionEntries();
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
    const main = getWindow();
    if (main && !main.isDestroyed()) {
        main.webContents.once('did-finish-load', () => {
            if (!isOnboardingNeeded()) return;
            try {
                openWizardWindow();
            } catch (e) {
                console.error('[plugin-wizard] could not open the first-run wizard', e);
            }
        });
    }
}
