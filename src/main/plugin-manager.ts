// Plugin Manager — handles installation, removal, and updates of plugins.
// Curated plugins install from the bundled catalog without Git (see
// plugin-installer.ts); the legacy git clone/pull paths remain for
// developer-supplied repository URLs.

import { app, ipcMain } from 'electron';
import { execFile } from 'child_process';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import {
    getCorePluginsDir,
    getPluginsDir,
    isRestarting,
    restartPython,
    restartPythonAndWait,
} from './python';
import {
    ActivationStatus,
    Catalog,
    FetchLike,
    InstallError,
    InstallOutcome,
    cleanupStaging,
    commitInstall,
    hasBackup,
    installCatalogBatch,
    loadCatalog,
    resolveSafePluginDir,
    rollbackInstall,
} from './plugin-installer';

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

function readManifest(dir: string): Record<string, any> | null {
    try {
        // dir is a scanned plugin directory; the file name is a literal
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal
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
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal
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
const MAX_CATALOG_SELECTION = 200;

/**
 * True for the whole of a catalog install or rollback (download, swap, backend
 * restart and activation poll), not just while a restart is running. Anything
 * else that would restart the backend must decline while this holds, or it
 * kills the server the activation poll is probing.
 */
export function isInstallBusy(): boolean {
    return catalogBusy || isRestarting();
}

async function installFromCatalog(ids: unknown): Promise<{ success: boolean; message: string; results: unknown[] }> {
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
    try {
        const pluginsDir = getPluginsDir();
        cleanupStaging(pluginsDir);
        const user = scanPluginDir(pluginsDir);
        const core = scanPluginDir(getCorePluginsDir());
        const results = await installCatalogBatch(ids as string[], getCatalog(), {
            pluginsDir,
            fetch: fetch as unknown as FetchLike,
            protectedIds: core.bundledIds,
            installedIds: new Set([...user.ids, ...core.ids]),
            activate: activateInstalled,
            restartAfterRollback: async () => { await restartPythonAndWait(); },
        });
        const failed = results.filter(r => !r.success).length;
        const message = failed === 0
            ? `Installed ${results.length} plugin${results.length === 1 ? '' : 's'}.`
            : `${results.length - failed} of ${results.length} plugin${results.length === 1 ? '' : 's'} installed.`;
        return { success: failed === 0, message, results };
    } catch (e) {
        console.error('[plugins] catalog install failed', e);
        const message = e instanceof InstallError ? e.message : 'Plugin installation failed.';
        return { success: false, message, results: [] };
    } finally {
        catalogBusy = false;
    }
}

function listCatalog(): unknown[] {
    let catalog: Catalog;
    try {
        catalog = getCatalog();
    } catch (e) {
        // A missing or damaged catalog is "nothing to offer", not an IPC error.
        console.error('[plugins] catalog unavailable', e);
        return [];
    }
    const pluginsDir = getPluginsDir();
    const installed = new Map<string, string>();
    for (const entry of fs.existsSync(pluginsDir) ? fs.readdirSync(pluginsDir) : []) {
        if (entry.startsWith('.')) continue;
        const manifest = readManifest(path.join(pluginsDir, entry));
        if (manifest && typeof manifest.id === 'string') installed.set(manifest.id, String(manifest.version ?? ''));
    }
    const bundled = scanPluginDir(getCorePluginsDir()).bundledIds;
    return catalog.entries.map(entry => ({
        ...entry,
        installedVersion: installed.get(entry.id) ?? null,
        bundled: bundled.has(entry.id),
        canRollback: hasBackup(pluginsDir, entry.installDir),
    }));
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

export function initPluginManager(): void {
    // Remove leftovers from an install interrupted by a crash or power loss.
    // Backups are deliberately kept for rollback.
    try { cleanupStaging(getPluginsDir()); } catch { /* best effort */ }

    ipcMain.handle('plugins:catalog', () => listCatalog());

    ipcMain.handle('plugins:installCatalog', async (_event, ids: unknown) => {
        return await installFromCatalog(ids);
    });

    ipcMain.handle('plugins:rollbackCatalog', async (_event, id: unknown) => {
        return await rollbackCatalogPlugin(id);
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
