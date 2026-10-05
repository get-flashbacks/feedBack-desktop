// Plugin Manager — handles installation, removal, and updates of plugins.
// Curated plugins install from the bundled catalog without Git (see
// plugin-installer.ts); the legacy git clone/pull paths remain for
// developer-supplied repository URLs.
//
// Every catalog install also records what it installed in the versioned
// installed-state record (plugin-installed-state.ts), and that record is what the
// per-plugin lifecycle operations in plugin-lifecycle.ts consult: an update, a
// downgrade, a pin, a disable and an uninstall are all "what does the record say
// about this plugin, and what does the catalog offer for it".

import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import {
    getConfigDir,
    getCorePluginsDir,
    getPluginsDir,
    isRestarting,
    restartPython,
    restartPythonAndWait,
} from './python';
import {
    ActivationStatus,
    Catalog,
    CatalogEntry,
    FetchLike,
    InstallError,
    InstallOutcome,
    InstallProgress,
    cleanupStaging,
    commitInstall,
    disablePlugin,
    enablePlugin,
    hasBackup,
    installCatalogBatch,
    installCatalogEntry,
    isPluginDisabled,
    loadCatalog,
    removePluginSource,
    resolveSafePluginDir,
    rollbackInstall,
} from './plugin-installer';
import {
    IPC_PLUGIN_CATALOG_CANCEL,
    IPC_PLUGIN_CATALOG_PROGRESS,
    IPC_PLUGIN_CHECK_UPDATES,
    IPC_PLUGIN_DOWNGRADE_CATALOG,
    IPC_PLUGIN_PIN_CATALOG,
    IPC_PLUGIN_SET_ENABLED,
    IPC_PLUGIN_UNINSTALL_CATALOG,
    IPC_PLUGIN_UPDATE_CATALOG,
} from './ipc-channels';
import {
    SelectionEntry,
    resolveSelection,
    selectableEntries,
    toSelectionEntries,
} from './plugin-selection';
import {
    InstalledPluginRecord,
    readInstalledState,
    updateInstalledState,
} from './plugin-installed-state';
import {
    downgradeCandidates,
    entryForPin,
    installRefusal,
    lifecycleView,
    nextRecordAfterInstall,
    pluginIdFrom,
    recordAfterPinChange,
    resolveUpdate,
    splitLifecycleRequests,
    updateCandidates,
    userDataPathsForPlugin,
    versionFrom,
} from './plugin-lifecycle';

// Run git with an explicit argv array — never via a shell. This removes the
// OS command-injection vector that `exec(`git clone ${gitUrl} ...`)` had:
// gitUrl/name are no longer interpolated into a shell string.
function execFileAsync(file: string, args: string[], cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(file, args, { cwd, timeout: 60000 }, (error, stdout, stderr) => {
            if (error) reject(new Error(stderr || error.message));
            else resolve(stdout.trim());
        });
    });
}

// Plugin directory names are a single path segment directly under the
// plugins dir — see resolveSafePluginDir in plugin-installer.ts, shared by the
// git paths below and the catalog installer.

// Require a well-formed https:// URL with a hostname so a renderer can't
// point git at a local path / file:// / ext:: transport (or a malformed
// `https:///` with no host). Parsing with URL also rejects whitespace and
// junk a bare prefix regex would let through. (Shell injection is already
// gone via execFile — this is transport/host hardening.)
function isValidGitUrl(url: string): boolean {
    try {
        const u = new URL(url);
        return u.protocol === 'https:' && u.hostname.length > 0;
    } catch {
        return false;
    }
}

interface InstalledPlugin {
    name: string;
    path: string;
    hasGit: boolean;
    manifest: any | null;
    version: string;
}

async function listInstalledPlugins(): Promise<InstalledPlugin[]> {
    const pluginsDir = getPluginsDir();
    const plugins: InstalledPlugin[] = [];

    if (!fs.existsSync(pluginsDir)) return plugins;

    const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;

        const pluginPath = path.join(pluginsDir, entry.name);

        // Accept real directories and symlinks that resolve to a directory.
        // The README documents symlinking a plugin repo into the plugins
        // dir, but Dirent.isDirectory() is false for a symlink-to-dir, so
        // stat the resolved path instead. statSync throws on a broken
        // symlink (or unreadable entry) — skip those.
        let isDir = false;
        try {
            isDir = fs.statSync(pluginPath).isDirectory();
        } catch { /* broken symlink or unreadable entry */ }
        if (!isDir) continue;
        const manifestPath = path.join(pluginPath, 'plugin.json');
        const gitDir = path.join(pluginPath, '.git');

        let manifest = null;
        try {
            if (fs.existsSync(manifestPath)) {
                manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            }
        } catch { /* invalid manifest */ }

        let version = manifest?.version || 'unknown';

        // Try to get git version info
        if (fs.existsSync(gitDir)) {
            try {
                const hash = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], pluginPath);
                version = `${version} (${hash})`;
            } catch { /* not a git repo */ }
        }

        plugins.push({
            name: entry.name,
            path: pluginPath,
            hasGit: fs.existsSync(gitDir),
            manifest,
            version,
        });
    }

    return plugins;
}

async function installPlugin(gitUrl: string, name?: string): Promise<{ success: boolean; message: string }> {
    const pluginsDir = getPluginsDir();

    if (typeof gitUrl !== 'string' || !isValidGitUrl(gitUrl)) {
        return { success: false, message: 'Invalid git URL — only https:// remotes are allowed' };
    }

    // Derive directory name from URL if not provided
    if (!name) {
        // https://github.com/user/slopsmith-plugin-foo.git -> slopsmith-plugin-foo
        const urlParts = gitUrl.replace(/\.git$/, '').split('/');
        name = urlParts[urlParts.length - 1] || 'plugin';
    }

    const targetDir = resolveSafePluginDir(pluginsDir, name);
    if (!targetDir) {
        return { success: false, message: `Invalid plugin name "${name}"` };
    }

    if (fs.existsSync(targetDir)) {
        return { success: false, message: `Plugin directory "${name}" already exists` };
    }

    try {
        await execFileAsync('git', ['clone', gitUrl, targetDir]);

        // Verify it has a plugin.json
        const manifestPath = path.join(targetDir, 'plugin.json');
        if (!fs.existsSync(manifestPath)) {
            console.warn(`[plugins] Warning: ${name} has no plugin.json — may not be a valid Slopsmith plugin`);
        }

        return { success: true, message: `Installed "${name}" successfully. Restart to activate.` };
    } catch (e: any) {
        // Clean up failed clone
        try { fs.rmSync(targetDir, { recursive: true }); } catch { /* ignore */ }
        return { success: false, message: `Failed to clone: ${e.message}` };
    }
}

async function removePlugin(name: string): Promise<{ success: boolean; message: string }> {
    const pluginsDir = getPluginsDir();
    const targetDir = resolveSafePluginDir(pluginsDir, name);
    if (!targetDir) {
        return { success: false, message: `Invalid plugin name "${name}"` };
    }

    if (!fs.existsSync(targetDir)) {
        return { success: false, message: `Plugin "${name}" not found` };
    }

    try {
        fs.rmSync(targetDir, { recursive: true });
        // Drop any catalog-install backup too, so a later install of the same
        // plugin can never "restore" a version the user removed.
        commitInstall(pluginsDir, name);
        return { success: true, message: `Removed "${name}". Restart to take effect.` };
    } catch (e: any) {
        return { success: false, message: `Failed to remove: ${e.message}` };
    }
}

async function updatePlugin(name: string): Promise<{ success: boolean; message: string }> {
    const pluginsDir = getPluginsDir();
    const targetDir = resolveSafePluginDir(pluginsDir, name);
    if (!targetDir) {
        return { success: false, message: `Invalid plugin name "${name}"` };
    }

    if (!fs.existsSync(targetDir)) {
        return { success: false, message: `Plugin "${name}" not found` };
    }

    if (!fs.existsSync(path.join(targetDir, '.git'))) {
        return { success: false, message: `Plugin "${name}" is not a git repository — cannot update` };
    }

    try {
        const output = await execFileAsync('git', ['pull'], targetDir);
        if (output.includes('Already up to date')) {
            return { success: true, message: `"${name}" is already up to date` };
        }
        return { success: true, message: `Updated "${name}". Restart to activate changes.` };
    } catch (e: any) {
        return { success: false, message: `Failed to update: ${e.message}` };
    }
}

// ── Catalog installation ────────────────────────────────────────────────

let cachedCatalog: Catalog | null = null;
function getCatalog(): Catalog {
    if (!cachedCatalog) {
        const catalogPath = app.isPackaged
            ? path.join(process.resourcesPath, 'plugin-catalog.json')
            : path.join(__dirname, '..', '..', 'resources', 'plugin-catalog.json');
        cachedCatalog = loadCatalog(catalogPath);
    }
    return cachedCatalog;
}

/**
 * Identifier of the catalog an install resolved from: the SHA-256 of the
 * catalog file's own bytes. The catalog ships inside the app, so it cannot
 * change under a running install, which makes this exactly "which catalog was
 * this entry taken from".
 */
let cachedRevision: string | null = null;
function catalogRevision(): string {
    if (cachedRevision) return cachedRevision;
    const catalogPath = app.isPackaged
        ? path.join(process.resourcesPath, 'plugin-catalog.json')
        : path.join(__dirname, '..', '..', 'resources', 'plugin-catalog.json');
    try {
        cachedRevision = crypto.createHash('sha256').update(fs.readFileSync(catalogPath)).digest('hex');
    } catch (e) {
        console.error('[plugins] could not identify the catalog', e);
        cachedRevision = 'unknown-catalog';
    }
    return cachedRevision;
}

/** Where the installed-state record lives (app.getPath('userData')). */
function installedStateDir(): string {
    return app.getPath('userData');
}

/** The recorded lifecycle state of every catalog install, keyed by plugin id. */
function recordedState(): Map<string, InstalledPluginRecord> {
    return readInstalledState(installedStateDir()).plugins;
}

function recordedFor(id: string): InstalledPluginRecord | null {
    return recordedState().get(id) ?? null;
}

/** Display name for a plugin id: the catalog's, or the id when unavailable. */
function catalogName(id: string): string {
    try {
        return getCatalog().byId.get(id)?.name ?? id;
    } catch {
        // A missing catalog must not turn a lifecycle operation into an error.
        return id;
    }
}

/**
 * Write the record for `entries` after they were installed. Any version they
 * displaced joins that plugin's history (see nextRecordAfterInstall), and the
 * serialized writer in plugin-installed-state.ts keeps this from clobbering a
 * concurrent install of a different plugin.
 */
async function recordInstalled(entries: CatalogEntry[], now = new Date().toISOString()): Promise<void> {
    if (!entries.length) return;
    const revision = catalogRevision();
    await updateInstalledState(installedStateDir(), (records) => {
        for (const entry of entries) {
            records.set(entry.id, nextRecordAfterInstall(records.get(entry.id) ?? null, entry, revision, now));
        }
    }, now);
}

/**
 * Record what landed on disk, reporting only the recording failure itself. Once a
 * version is live and the backend has accepted it, its rollback backup is already
 * gone, so turning a record that will not write into a failed install would be
 * the less honest answer — and the plugins dir stays the authority either way.
 */
async function recordQuietly(entries: CatalogEntry[]): Promise<void> {
    try {
        await recordInstalled(entries);
    } catch (e) {
        console.error('[plugins] could not record the installed state', e);
    }
}

function readManifest(dir: string): Record<string, any> | null {
    try {
        // dir is a scanned plugin directory; the file name is a literal
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf-8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

// Mirrors the backend's _is_bundled(): a core plugin wins over a user copy
// only when it sits directly in the core plugins dir, its manifest says
// `"bundled": true`, and its directory name equals its id. Any other core
// plugin with the same id is overridden by the user-installed copy, because
// the backend scans the user plugins dir first.
function scanPluginDir(dir: string): { ids: Set<string>; bundledIds: Set<string> } {
    const ids = new Set<string>();
    const bundledIds = new Set<string>();
    let entries: fs.Dirent[] = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return { ids, bundledIds };
    }
    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        // entry.name comes from readdirSync of the app's own plugins directory
        const manifest = readManifest(path.join(dir, entry.name));
        if (!manifest || typeof manifest.id !== 'string') continue;
        ids.add(manifest.id);
        if (manifest.bundled === true && entry.name === manifest.id) bundledIds.add(manifest.id);
    }
    return { ids, bundledIds };
}

// A cold backend enumerating its plugins can take well over 5s to answer, and
// the request is destroyed mid-response on timeout, so allow generous headroom.
const PROBE_TIMEOUT_MS = 20000;
// How long a plugin may be absent from an answer that did arrive before it is
// called a load failure.
const MISSING_ROW_GRACE_MS = 30000;

function fetchLoadedPlugins(port: number): Promise<any[]> {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/api/plugins`, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
                let parsed: unknown;
                try {
                    parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
                } catch (e) {
                    reject(e);
                    return;
                }
                // A body that is not the documented array is an unusable answer,
                // not an answer of "no plugins loaded" — reject so the caller
                // retries instead of failing every plugin.
                if (!Array.isArray(parsed)) {
                    reject(new Error('unexpected /api/plugins response'));
                    return;
                }
                resolve(parsed);
            });
        });
        req.on('error', reject);
        req.setTimeout(PROBE_TIMEOUT_MS, () => req.destroy(new Error('timeout')));
    });
}

/**
 * The deadline passed with nothing conclusive: the plugin may still be
 * installing dependencies, or the probe never answered. Not a failure, but
 * not a confirmation either, so the backup is left in place.
 */
function unconfirmed(statuses: Map<string, ActivationStatus>, outcomes: InstallOutcome[]): Map<string, ActivationStatus> {
    for (const outcome of outcomes) {
        if (!statuses.has(outcome.id)) {
            statuses.set(outcome.id, { ok: true, confirmed: false });
            console.warn(`[plugins] ${outcome.id} activation unconfirmed; keeping the previous version as a fallback`);
        }
    }
    return statuses;
}

// Restart the backend once, then wait for each freshly installed plugin to
// leave the "installing" state (its pip requirements install in the
// background) and report whether it reached ready/disabled at the expected
// version.
async function activateInstalled(outcomes: InstallOutcome[]): Promise<Map<string, ActivationStatus>> {
    const port = await restartPythonAndWait();
    const deadline = Date.now() + 10 * 60 * 1000;
    const statuses = new Map<string, ActivationStatus>();
    // A row that is missing from an answer is not yet conclusive: the backend
    // may enumerate a freshly installed plugin a poll or two late. Only after
    // this grace window has passed does a missing row become a load failure.
    const missingSince = new Map<string, number>();
    for (;;) {
        let rows: any[] | null = null;
        try {
            rows = await fetchLoadedPlugins(port);
        } catch {
            // The probe did not answer. That says nothing about any plugin, so
            // keep polling instead of evaluating statuses.
            rows = null;
        }
        if (rows === null) {
            // An outage says nothing about a missing row, so the grace window
            // must not keep ageing across it.
            missingSince.clear();
            if (Date.now() > deadline) return unconfirmed(statuses, outcomes);
            await new Promise(r => setTimeout(r, 2000));
            continue;
        }
        const byId = new Map(rows.filter(r => r && typeof r.id === 'string').map(r => [r.id, r]));
        let pending = false;
        for (const outcome of outcomes) {
            // A conclusive result is final: a later poll (backend reload,
            // re-enumeration) must not turn a confirmed plugin into a failure.
            if (statuses.has(outcome.id)) continue;
            const row = byId.get(outcome.id);
            if (row) missingSince.delete(outcome.id);
            if (row?.status === 'installing') { pending = true; continue; }
            if (!row) {
                const since = missingSince.get(outcome.id) ?? Date.now();
                missingSince.set(outcome.id, since);
                if (Date.now() - since < MISSING_ROW_GRACE_MS) { pending = true; continue; }
                statuses.set(outcome.id, { ok: false, message: 'it was not loaded by the server' });
            } else if (row.status === 'failed') {
                statuses.set(outcome.id, { ok: false, message: 'the server reported a load error' });
                if (row.error) console.error(`[plugins] ${outcome.id} failed to activate: ${row.error}`);
            } else if (row.version !== outcome.version) {
                statuses.set(outcome.id, { ok: false, message: 'a different copy was loaded instead' });
            } else {
                statuses.set(outcome.id, { ok: true, confirmed: true });
            }
        }
        if (!pending) return statuses;
        if (Date.now() > deadline) return unconfirmed(statuses, outcomes);
        await new Promise(r => setTimeout(r, 2000));
    }
}

let catalogBusy = false;
// One in-flight batch, so a cancel from either UI (the first-run wizard or the
// Plugin Manager) reaches the running download instead of racing a second one.
let catalogAbort: AbortController | null = null;
const MAX_CATALOG_SELECTION = 200;

// Ticks are per download chunk, so they are throttled before crossing the IPC
// boundary (~5/s, like the soundfont downloader).
const PROGRESS_INTERVAL_MS = 200;
function broadcastInstallProgress(progress: InstallProgress): void {
    for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        win.webContents.send(IPC_PLUGIN_CATALOG_PROGRESS, progress);
    }
}

/**
 * True for the whole of a catalog install or rollback (download, swap, backend
 * restart and activation poll), not just while a restart is running. Anything
 * else that would restart the backend must decline while this holds, or it
 * kills the server the activation poll is probing.
 */
export function isInstallBusy(): boolean {
    return catalogBusy || isRestarting();
}

/**
 * Abort the running catalog batch. Deliberately does not clear `catalogBusy`:
 * the batch unwinds on its own and restores the flag, so a cancel can't be
 * mistaken for "nothing is running" while files are still being swapped.
 */
export function cancelCatalogInstall(): { success: boolean; message: string } {
    if (!catalogAbort) return { success: false, message: 'No plugin installation is running.' };
    catalogAbort.abort();
    return { success: true, message: 'Cancelling the plugin installation…' };
}

export interface CatalogInstallOptions {
    /** Progress sink; defaults to a throttled broadcast to every window. */
    onProgress?: (progress: InstallProgress) => void;
    signal?: AbortSignal;
}

export async function installFromCatalog(
    ids: unknown,
    options: CatalogInstallOptions = {},
): Promise<{ success: boolean; message: string; results: unknown[] }> {
    if (!Array.isArray(ids) || ids.length === 0) {
        return { success: false, message: 'Select at least one plugin to install.', results: [] };
    }
    if (ids.length > MAX_CATALOG_SELECTION) {
        return { success: false, message: `Select at most ${MAX_CATALOG_SELECTION} plugins at a time.`, results: [] };
    }
    if (catalogBusy) {
        return { success: false, message: 'Another plugin installation is already running.', results: [] };
    }
    catalogBusy = true;
    const controller = new AbortController();
    catalogAbort = controller;
    let lastProgressAt = 0;
    const onProgress = options.onProgress ?? ((progress: InstallProgress) => {
        const now = Date.now();
        // Always forward terminal phases; throttle only the byte ticks.
        if (progress.phase === 'download' && now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
        lastProgressAt = now;
        broadcastInstallProgress(progress);
    });
    try {
        const pluginsDir = getPluginsDir();
        cleanupStaging(pluginsDir);
        const user = scanPluginDir(pluginsDir);
        const core = scanPluginDir(getCorePluginsDir());
        const catalog = getCatalog();
        // A pin or a disable is the user's decision about an installed copy, so
        // the batch path honours it too — selecting a pinned plugin in the
        // catalog list must not be a way around "leave this version alone". A copy
        // the catalog is behind is refused for the same reason: that install is a
        // downgrade, and a downgrade only reinstalls a pin from the record.
        const { allowed, refused } = splitLifecycleRequests(ids as string[], recordedState(), catalog.entries);
        const results = await installCatalogBatch(allowed, catalog, {
            pluginsDir,
            fetch: fetch as unknown as FetchLike,
            protectedIds: core.bundledIds,
            installedIds: new Set([...user.ids, ...core.ids]),
            activate: activateInstalled,
            restartAfterRollback: async () => { await restartPythonAndWait(); },
            onProgress,
            signal: options.signal ?? controller.signal,
        });
        const all = [...refused, ...results];
        const failed = all.filter(r => !r.success).length;
        const cancelled = controller.signal.aborted;
        // Record what actually landed, before reporting: a plugin the batch
        // rolled back is not in `results` as installed, so the record and the
        // catalog list agree about what is on disk.
        await recordQuietly(results
            .filter(r => r.success)
            .map(r => catalog.byId.get(r.id))
            .filter((entry): entry is CatalogEntry => entry !== undefined));
        const message = cancelled
            ? 'Plugin installation cancelled. You can resume it from the Plugin Manager.'
            : failed === 0
                ? `Installed ${all.length} plugin${all.length === 1 ? '' : 's'}.`
                : `${all.length - failed} of ${all.length} plugin${all.length === 1 ? '' : 's'} installed.`;
        return { success: failed === 0 && !cancelled, message, results: all };
    } catch (e) {
        console.error('[plugins] catalog install failed', e);
        const message = e instanceof InstallError ? e.message : 'Plugin installation failed.';
        return { success: false, message, results: [] };
    } finally {
        catalogAbort = null;
        catalogBusy = false;
    }
}

// A missing or damaged catalog used to answer with a bare empty array, which
// the renderer cannot tell apart from a catalog that genuinely offers nothing.
// Report the failure so the catalog view can say why it is empty. This covers
// what loadCatalog throws on — a missing, unparseable or wrong-version file.
// Entries the loader rejects individually are still dropped silently by design,
// so a catalog whose every entry fails the runtime gate still answers ok.
function listCatalog(): { ok: boolean; entries: unknown[]; message?: string } {
export function listCatalog(): unknown[] {
    let catalog: Catalog;
    try {
        catalog = getCatalog();
    } catch (e) {
        console.error('[plugins] catalog unavailable', e);
        return {
            ok: false,
            entries: [],
            message: e instanceof InstallError ? e.message : 'The plugin catalog could not be read.',
        };
    }
    const pluginsDir = getPluginsDir();
    const installed = new Map<string, string>();
    for (const entry of fs.existsSync(pluginsDir) ? fs.readdirSync(pluginsDir) : []) {
        if (entry.startsWith('.')) continue;
        const manifest = readManifest(path.join(pluginsDir, entry));
        if (manifest && typeof manifest.id === 'string') installed.set(manifest.id, String(manifest.version ?? ''));
    }
    const bundled = scanPluginDir(getCorePluginsDir()).bundledIds;
    return {
        ok: true,
        entries: catalog.entries.map(entry => ({
            ...entry,
            installedVersion: installed.get(entry.id) ?? null,
            bundled: bundled.has(entry.id),
            canRollback: hasBackup(pluginsDir, entry.installDir),
        })),
    };
    const records = recordedState();
    return catalog.entries.map(entry => {
        const record = records.get(entry.id) ?? null;
        const disabled = isPluginDisabled(pluginsDir, entry.installDir);
        const view = lifecycleView({
            entry,
            record,
            disabled,
            // A disabled copy has no backup to restore: disabling dropped it, so
            // "restore previous" must not offer a version from before the state
            // the user chose.
            canRollback: !disabled && hasBackup(pluginsDir, entry.installDir),
        });
        return {
            ...entry,
            ...view,
            // The record is what the lifecycle acts on; the directory is what the
            // backend loads. They agree once every install is recorded, and when
            // they do not, the copy on disk is the one the user is looking at.
            installedVersion: installed.get(entry.id) ?? view.installedVersion,
            bundled: bundled.has(entry.id),
        };
    });
}

/**
 * Which installed plugins an update check would replace. Excludes pinned and
 * disabled plugins, so holding a version is honoured by the check itself rather
 * than only by the screen showing it.
 */
export function checkCatalogUpdates(): { ids: string[]; count: number } {
    let ids: string[] = [];
    try {
        ids = updateCandidates(recordedState(), getCatalog().entries);
    } catch (e) {
        // No catalog means nothing to update to, not a failure to report.
        console.error('[plugins] catalog unavailable', e);
    }
    return { ids, count: ids.length };
}

/**
 * The catalog as the selection layer sees it: metadata plus live install state.
 * A missing or damaged catalog yields an empty list — "nothing to offer", never
 * a failed launch.
 */
export function catalogSelectionEntries(): SelectionEntry[] {
    try {
        return toSelectionEntries(listCatalog());
    } catch (e) {
        console.error('[plugins] catalog unavailable', e);
        return [];
    }
}

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

export interface CatalogInstallPlan {
    /** The resolved set, dependencies first: what the caller shows the user. */
    ids: string[];
    /** The part of it the batch will actually download. */
    outstanding: string[];
}

/**
 * Resolve a caller-supplied selection before anything is installed: the
 * dependency closure and conflict pruning of plugin-selection.ts, with locked
 * (essential) entries kept in the set, then everything already installed at its
 * pinned version — or bundled with the app — dropped, because the batch skips
 * those anyway.
 *
 * The renderer never gets to name a plugin outside the catalog, bypass a
 * dependency or force a conflicting pair through, whichever screen it came from:
 * the batch installer only orders dependencies that are themselves in the
 * selection, so an unresolved id would come back as "X requires Y".
 */
export function planCatalogInstall(rawIds: unknown): CatalogInstallPlan {
    const entries = catalogSelectionEntries();
    const requested = Array.isArray(rawIds) ? rawIds.filter((id): id is string => typeof id === 'string') : [];
    const plan = resolveSelection(entries, requested);
    const locked = selectableEntries(entries).filter(e => e.tier === 'essential').map(e => e.id);
    const resolved = resolveSelection(entries, [...locked, ...plan.ids]);
    return { ids: resolved.ids, outstanding: outstandingIds(entries, resolved.ids) };
}

async function rollbackCatalogPlugin(id: unknown): Promise<{ success: boolean; message: string }> {
    let entry;
    try {
        entry = typeof id === 'string' ? getCatalog().byId.get(id) : undefined;
    } catch (e) {
        console.error('[plugins] catalog unavailable', e);
        return { success: false, message: e instanceof InstallError ? e.message : 'The plugin catalog is unavailable.' };
    }
    if (!entry) return { success: false, message: 'That plugin is not available in the catalog.' };
    if (catalogBusy) return { success: false, message: 'A plugin installation is running.' };
    if (!hasBackup(getPluginsDir(), entry.installDir)) {
        return { success: false, message: `No previous version of ${entry.name} is available.` };
    }
    catalogBusy = true;
    try {
        await rollbackInstall(getPluginsDir(), entry.installDir);
        return { success: true, message: `Restored the previous version of ${entry.name}. Restart to activate.` };
    } catch (e) {
        return { success: false, message: e instanceof InstallError ? e.message : 'Rollback failed.' };
    } finally {
        catalogBusy = false;
    }
}

// ── Per-plugin lifecycle (issue #21) ───────────────────────────────────

/** Progress ticks for one plugin, throttled exactly like the batch's. */
function throttledProgress(): (progress: InstallProgress) => void {
    let lastAt = 0;
    return (progress) => {
        const now = Date.now();
        if (progress.phase === 'download' && now - lastAt < PROGRESS_INTERVAL_MS) return;
        lastAt = now;
        broadcastInstallProgress(progress);
    };
}

/**
 * Why an operation that needs an installed copy cannot go ahead, or null when it
 * can. A plugin with no record was not installed through this Plugin Manager (a
 * git checkout, or an install from before the record existed), so none of the
 * lifecycle operations claim it: they have no verified pin to update from or
 * fall back to.
 */
function unmanagedReason(id: string): string | null {
    const record = recordedFor(id);
    if (!record) {
        return 'This plugin was not installed through the Plugin Manager, so it has no recorded version to update, pin or remove safely.';
    }
    if (!record.enabled && isPluginDisabled(getPluginsDir(), record.installDir)) {
        return 'This plugin is disabled. Enable it first.';
    }
    return null;
}

/**
 * Install one entry over the copy on disk and activate it: install, restart the
 * backend, and keep the new version only if the server loaded it.
 *
 * The record is written after the backend has accepted the version, and not at
 * all when the install was rolled back — so the record never claims a version
 * that is not on disk.
 */
async function installOverInstalled(
    entry: CatalogEntry,
    options: { verb: 'Updated' | 'Downgraded'; onProgress?: (progress: InstallProgress) => void },
): Promise<{ success: boolean; message: string }> {
    const pluginsDir = getPluginsDir();
    if (catalogBusy) return { success: false, message: 'A plugin installation is already running.' };
    catalogBusy = true;
    try {
        cleanupStaging(pluginsDir);
        const core = scanPluginDir(getCorePluginsDir());
        const outcome = await installCatalogEntry(entry, {
            pluginsDir,
            fetch: fetch as unknown as FetchLike,
            protectedIds: core.bundledIds,
            onProgress: options.onProgress ?? throttledProgress(),
        });
        const status = (await activateInstalled([outcome])).get(entry.id);
        if (status?.ok && status.confirmed !== false) {
            commitInstall(pluginsDir, entry.installDir);
            await recordQuietly([entry]);
            return { success: true, message: `${options.verb} ${entry.name} to ${entry.version}.` };
        }
        if (status?.ok) {
            // The server answered but never confirmed the load, which is not the
            // same as it working. Keep the backup as the way back and say so
            // rather than claiming the update succeeded.
            await recordQuietly([entry]);
            return {
                success: true,
                message: `${options.verb} ${entry.name} to ${entry.version}, but the server did not confirm it started. `
                    + 'Restart the app to check, and use "Restore previous" if it does not work.',
            };
        }
        let restored = 'It was removed.';
        try {
            if (await rollbackInstall(pluginsDir, entry.installDir) === 'restored') {
                restored = 'The previous version was restored.';
            }
        } catch (e) {
            restored = e instanceof InstallError ? e.message : 'The previous version could not be restored.';
        }
        return {
            success: false,
            message: `${entry.name} did not start${status?.message ? ` (${status.message})` : ''}. ${restored}`,
        };
    } catch (e) {
        console.error('[plugins] lifecycle install failed', e);
        return { success: false, message: e instanceof InstallError ? e.message : `${entry.name} could not be installed.` };
    } finally {
        catalogBusy = false;
    }
}

/**
 * Install the catalog's version over an installed copy. Refuses a pinned or
 * disabled plugin with the reason, so the screen cannot offer an update the main
 * process would only reject.
 */
export async function updateCatalogPlugin(
    id: unknown,
    options: { onProgress?: (progress: InstallProgress) => void } = {},
): Promise<{ success: boolean; message: string }> {
    const pluginId = pluginIdFrom(id);
    if (!pluginId) return { success: false, message: 'That plugin could not be identified.' };
    let entry: CatalogEntry | undefined;
    try {
        entry = getCatalog().byId.get(pluginId);
    } catch (e) {
        console.error('[plugins] catalog unavailable', e);
        return { success: false, message: 'The plugin catalog is unavailable.' };
    }
    if (!entry) return { success: false, message: 'That plugin is not available in the catalog.' };
    const unmanaged = unmanagedReason(pluginId);
    if (unmanaged) return { success: false, message: unmanaged };
    const record = recordedFor(pluginId)!;
    if (!resolveUpdate(record, entry)) {
        return { success: false, message: installRefusal(entry, record) ?? 'There is nothing to update.' };
    }
    return await installOverInstalled(entry, { verb: 'Updated', onProgress: options.onProgress });
}

/**
 * Reinstall an earlier version from this plugin's own history. Only a pin the
 * record already carries can be chosen, so the download is verified against the
 * digest that was pinned when that version was current. Works on a pinned copy —
 * and clears the pin, since the pin was a statement about the version that has
 * just been replaced.
 */
export async function downgradeCatalogPlugin(id: unknown, version: unknown): Promise<{ success: boolean; message: string }> {
    const pluginId = pluginIdFrom(id);
    const target = versionFrom(version);
    if (!pluginId || !target) return { success: false, message: 'That version could not be identified.' };
    let entry: CatalogEntry | undefined;
    try {
        entry = getCatalog().byId.get(pluginId);
    } catch (e) {
        console.error('[plugins] catalog unavailable', e);
        return { success: false, message: 'The plugin catalog is unavailable.' };
    }
    if (!entry) return { success: false, message: 'That plugin is not available in the catalog.' };
    const unmanaged = unmanagedReason(pluginId);
    if (unmanaged) return { success: false, message: unmanaged };
    const record = recordedFor(pluginId)!;
    const pin = downgradeCandidates(record).find(candidate => candidate.version === target);
    if (!pin) {
        const known = downgradeCandidates(record).map(candidate => candidate.version).join(', ');
        return {
            success: false,
            message: known
                ? `${entry.name} has no earlier version ${target}. Earlier versions: ${known}.`
                : `No earlier version of ${entry.name} has been recorded, so there is nothing to downgrade to.`,
        };
    }
    let targetEntry: CatalogEntry;
    try {
        targetEntry = entryForPin(record, pin, entry.name);
    } catch (e) {
        console.error('[plugins] recorded version cannot be reinstalled', e);
        return { success: false, message: e instanceof InstallError ? e.message : 'That earlier version cannot be reinstalled.' };
    }
    return await installOverInstalled(targetEntry, { verb: 'Downgraded' });
}

/** Hold the recorded version, or release it. */
export async function pinCatalogPlugin(id: unknown, pinned: unknown): Promise<{ success: boolean; message: string }> {
    const pluginId = pluginIdFrom(id);
    if (typeof pinned !== 'boolean') return { success: false, message: 'That request could not be understood.' };
    if (!pluginId) return { success: false, message: 'That plugin could not be identified.' };
    const name = catalogName(pluginId);
    const record = recordedFor(pluginId);
    if (!record) {
        return {
            success: false,
            message: `${name} is not installed through the Plugin Manager, so it has no version to ${pinned ? 'pin' : 'unpin'}.`,
        };
    }
    if (record.pinned === pinned) {
        return { success: true, message: pinned ? `${name} is already pinned.` : `${name} is not pinned.` };
    }
    try {
        await updateInstalledState(installedStateDir(), (records) => {
            const current = records.get(pluginId);
            if (current) records.set(pluginId, recordAfterPinChange(current, pinned));
        }, new Date().toISOString());
    } catch (e) {
        console.error('[plugins] could not record the pin change', e);
        return { success: false, message: e instanceof InstallError ? e.message : 'The pin could not be saved.' };
    }
    return {
        success: true,
        message: pinned
            ? `${name} is pinned at ${record.version}. It will be left alone by update checks.`
            : `${name} is no longer pinned.`,
    };
}

/**
 * Disable or re-enable a copy. Disabling parks the directory outside the
 * backend's scan; re-enabling moves the same files back. Neither downloads
 * anything, and neither touches the plugin's data.
 */
export async function setCatalogPluginEnabled(id: unknown, enabled: unknown): Promise<{ success: boolean; message: string }> {
    const pluginId = pluginIdFrom(id);
    if (typeof enabled !== 'boolean') return { success: false, message: 'That request could not be understood.' };
    if (!pluginId) return { success: false, message: 'That plugin could not be identified.' };
    const name = catalogName(pluginId);
    const record = recordedFor(pluginId);
    if (!record) {
        return {
            success: false,
            message: `${name} is not installed through the Plugin Manager, so it cannot be disabled or enabled here.`,
        };
    }
    const pluginsDir = getPluginsDir();
    if (catalogBusy) return { success: false, message: 'A plugin installation is already running.' };
    catalogBusy = true;
    const parked = isPluginDisabled(pluginsDir, record.installDir);
    if (record.enabled === enabled && enabled === !parked) {
        catalogBusy = false;
        return { success: true, message: enabled ? `${name} is enabled.` : `${name} is disabled.` };
    }
    let moved = false;
    try {
        if (enabled && parked) {
            await enablePlugin(pluginsDir, record.installDir);
            moved = true;
        } else if (!enabled) {
            await disablePlugin(pluginsDir, record.installDir);
            moved = true;
        } else if (!copyPresent(pluginsDir, record.installDir)) {
            // Nothing parked and nothing installed: there is no copy to enable.
            throw new InstallError('This plugin is not disabled, and no copy of it is installed.');
        }
        // A record that calls a live copy "disabled" is stale, not a refusal:
        // the directory is what the backend loads, so the record catches up
        // rather than the move being refused.
    } catch (e) {
        catalogBusy = false;
        console.error('[plugins] could not change the enabled state', e);
        return { success: false, message: e instanceof InstallError ? e.message : `${name} could not be ${enabled ? 'enabled' : 'disabled'}.` };
    }
    // Undo the move when the state cannot be recorded, so the record and the
    // filesystem do not disagree about which copy is live.
    try {
        await updateInstalledState(installedStateDir(), (records) => {
            const current = records.get(pluginId);
            if (current) records.set(pluginId, { ...current, enabled });
        }, new Date().toISOString());
    } catch (e) {
        console.error('[plugins] could not record the enabled state', e);
        // Only reverse a move that happened: a reconciliation that changed
        // nothing on disk has nothing to undo.
        if (moved) {
            try {
                if (enabled) await disablePlugin(pluginsDir, record.installDir);
                else await enablePlugin(pluginsDir, record.installDir);
            } catch (undoError) {
                console.error('[plugins] could not undo the state change', undoError);
            }
        }
        catalogBusy = false;
        return { success: false, message: `${name} could not be ${enabled ? 'enabled' : 'disabled'}; its state was not saved.` };
    }
    catalogBusy = false;
    try {
        // The backend caches what it loaded, so the change only takes effect on a
        // restart. Report that honestly instead of claiming it is already done.
        await restartPythonAndWait();
    } catch (e) {
        console.error('[plugins] restart after the state change failed', e);
        return {
            success: true,
            message: `${name} was ${enabled ? 'enabled' : 'disabled'}. Restart the app to apply it.`,
        };
    }
    return { success: true, message: `${name} was ${enabled ? 'enabled' : 'disabled'}.` };
}

/** True when a copy of `installDir` is on disk, live or parked. */
function copyPresent(pluginsDir: string, installDir: string): boolean {
    try {
        return isPluginDisabled(pluginsDir, installDir)
            || fs.existsSync(resolveSafePluginDir(pluginsDir, installDir) ?? path.join(pluginsDir, installDir));
    } catch (e) {
        console.error('[plugins] could not inspect a plugin copy', e);
        return false;
    }
}

/** Names found under `plugin_data`, for the plugin-data deletion decision. */
function pluginDataEntries(): string[] {
    const dir = path.join(getConfigDir(), 'plugin_data');
    try {
        return fs.readdirSync(dir);
    } catch {
        return [];
    }
}

/**
 * Delete a plugin's own data. Only the fixed set of paths the app created for
 * that plugin id is removed; anything else under the config dir is the backend's
 * own and is left alone.
 */
function deletePluginData(id: string): string[] {
    const removed: string[] = [];
    for (const target of userDataPathsForPlugin(getConfigDir(), id, pluginDataEntries())) {
        try {
            fs.rmSync(target, { recursive: true, force: true });
            removed.push(target);
        } catch (e) {
            console.error('[plugins] could not remove plugin data', e);
        }
    }
    return removed;
}

/**
 * Remove an installed copy. The record is dropped only after the files are gone,
 * and a copy that is disabled is removed from the disabled slot, so neither state
 * can outlive an uninstall.
 */
export async function uninstallCatalogPlugin(id: unknown, deleteData: boolean): Promise<{ success: boolean; message: string }> {
    const pluginId = pluginIdFrom(id);
    if (!pluginId) return { success: false, message: 'That plugin could not be identified.' };
    const name = catalogName(pluginId);
    const record = recordedFor(pluginId);
    const pluginsDir = getPluginsDir();
    let entry: CatalogEntry | undefined;
    try {
        entry = getCatalog().byId.get(pluginId);
    } catch {
        entry = undefined;
    }
    // The record's own directory is authoritative; the catalog's is the fallback
    // for a copy that is on disk but was never recorded (an install from before
    // the record existed). Never guess a directory name from the plugin id.
    const installDir = record?.installDir ?? entry?.installDir;
    if (!installDir || !copyPresent(pluginsDir, installDir)) {
        return { success: false, message: `${name} is not installed.` };
    }
    if (catalogBusy) return { success: false, message: 'A plugin installation is already running.' };
    catalogBusy = true;
    let wasLive = false;
    try {
        const removed = removePluginSource(pluginsDir, installDir);
        wasLive = removed.live;
    } catch (e) {
        catalogBusy = false;
        console.error('[plugins] could not remove the plugin', e);
        return { success: false, message: e instanceof InstallError ? e.message : `${name} could not be removed.` };
    }
    // The files are already gone, so a record that will not drop cannot be
    // repaired by refusing: it is reported instead, because a row that still
    // claims an installed version offers operations that can only fail.
    let recordStale = false;
    try {
        await updateInstalledState(installedStateDir(), (records) => { records.delete(pluginId); }, new Date().toISOString());
    } catch (e) {
        console.error('[plugins] could not update the installed-state record', e);
        recordStale = true;
    }
    catalogBusy = false;
    let message = `Removed ${name}.`;
    if (recordStale) {
        message += ' Its record could not be updated, so this plugin may still be listed as installed.';
    }
    if (deleteData) {
        const removed = deletePluginData(pluginId);
        message += removed.length
            ? ` Its data (${removed.length} location${removed.length === 1 ? '' : 's'}) was deleted.`
            : ' It had no stored data.';
    } else {
        message += ' Its data was kept.';
    }
    if (wasLive) {
        try {
            await restartPythonAndWait();
        } catch (e) {
            console.error('[plugins] restart after uninstall failed', e);
            message += ' Restart the app to finish applying it.';
        }
    }
    return { success: true, message };
}

export function initPluginManager(getWindow: () => BrowserWindow | null = () => null): void {
    // Remove leftovers from an install interrupted by a crash or power loss.
    // Backups are deliberately kept for rollback.
    try { cleanupStaging(getPluginsDir()); } catch { /* best effort */ }

    ipcMain.handle('plugins:catalog', () => listCatalog());

    ipcMain.handle('plugins:installCatalog', async (_event, ids: unknown) => {
        // Resolved in main, like the wizard's own install: dependencies and
        // conflicts are settled against the bundled catalog rather than left for
        // the batch installer to refuse.
        return await installFromCatalog(planCatalogInstall(ids).outstanding);
    });

    ipcMain.handle(IPC_PLUGIN_CATALOG_CANCEL, () => cancelCatalogInstall());

    ipcMain.handle('plugins:rollbackCatalog', async (_event, id: unknown) => {
        return await rollbackCatalogPlugin(id);
    });

    ipcMain.handle(IPC_PLUGIN_CHECK_UPDATES, () => checkCatalogUpdates());

    ipcMain.handle(IPC_PLUGIN_UPDATE_CATALOG, async (_event, id: unknown) => {
        return await updateCatalogPlugin(id);
    });

    ipcMain.handle(IPC_PLUGIN_DOWNGRADE_CATALOG, async (_event, id: unknown, version: unknown) => {
        return await downgradeCatalogPlugin(id, version);
    });

    ipcMain.handle(IPC_PLUGIN_PIN_CATALOG, async (_event, id: unknown, pinned: unknown) => {
        return await pinCatalogPlugin(id, pinned);
    });

    ipcMain.handle(IPC_PLUGIN_SET_ENABLED, async (_event, id: unknown, enabled: unknown) => {
        return await setCatalogPluginEnabled(id, enabled);
    });

    ipcMain.handle(IPC_PLUGIN_UNINSTALL_CATALOG, async (_event, id: unknown) => {
        const pluginId = pluginIdFrom(id);
        if (!pluginId) return { success: false, message: 'That plugin could not be identified.' };
        const name = catalogName(pluginId);
        // The choice between keeping and deleting the user's data is made here,
        // in a native dialog with both outcomes spelled out, and never by the
        // renderer asserting a flag: "Uninstall" keeps the data and only
        // "Uninstall and delete data" removes it.
        const window = getWindow();
        const choice = await (window && !window.isDestroyed()
            ? dialog.showMessageBox(window, {
                type: 'warning',
                buttons: ['Cancel', 'Uninstall', 'Uninstall and delete data'],
                defaultId: 0,
                cancelId: 0,
                title: `Uninstall ${name}`,
                message: `Uninstall ${name}?`,
                detail: `The plugin and its stored settings are removed either way.\n\n`
                    + 'Choose "Uninstall and delete data" only if you want its settings and downloaded dependencies gone too.',
                noLink: true,
            })
            : { response: 0 });
        if (choice.response !== 1 && choice.response !== 2) {
            return { success: false, message: 'Uninstall cancelled.' };
        }
        return await uninstallCatalogPlugin(pluginId, choice.response === 2);
    });

    ipcMain.handle('plugins:listInstalled', async () => {
        return await listInstalledPlugins();
    });

    ipcMain.handle('plugins:install', async (_event, gitUrl: string, name?: string) => {
        return await installPlugin(gitUrl, name);
    });

    ipcMain.handle('plugins:remove', async (_event, name: string) => {
        return await removePlugin(name);
    });

    ipcMain.handle('plugins:update', async (_event, name: string) => {
        return await updatePlugin(name);
    });

    ipcMain.handle('plugins:restart', () => {
        if (isInstallBusy()) {
            return { success: false, message: 'A plugin installation is in progress. Try again when it finishes.' };
        }
        restartPython();
        return { success: true, message: 'Restarting server...' };
    });
}
