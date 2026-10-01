// Catalog-based plugin installer (issue #3).
//
// Installs curated plugins from the bundled, release-locked catalog
// (resources/plugin-catalog.json) without requiring Git. Every install:
//
//   1. resolves the entry from the bundled catalog only (callers pass an id,
//      never a URL), and builds the codeload URL from the pinned commit;
//   2. downloads over HTTPS with a hard byte cap equal to the pinned size and
//      verifies the SHA-256 against the catalog;
//   3. parses the ZIP with the validating reader in plugin-archive.ts
//      (traversal / absolute / symlink / layout / size checks), checks the
//      archive is the pinned commit, and validates plugin.json id + version;
//   4. extracts into a private staging directory on the same filesystem as
//      the plugins root, never touching the live installation;
//   5. swaps the staged tree into place with renames, moving any previous
//      version into a backup slot so it can be restored if activation fails.
//
// Pure Node (no electron import) so the whole pipeline is unit-testable; the
// IPC wiring, backend restart and activation probe live in plugin-manager.ts.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
    ArchiveError,
    DEFAULT_ARCHIVE_LIMITS,
    ArchiveLimits,
    extractArchive,
    parseArchive,
    readEntryData,
    singleRootPrefix,
} from './plugin-archive';

/** User-facing install failure. Messages never contain filesystem paths. */
export class InstallError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InstallError';
    }
}

export interface CatalogEntry {
    id: string;
    installDir: string;
    name: string;
    repository: string;
    version: string;
    commit: string;
    archiveSha256: string;
    source: 'get-flashbacks' | 'upstream-official' | 'reviewed-community';
    dependencies: string[];
    conflicts: string[];
    size: { downloadBytes: number; installedBytes: number };
    [key: string]: unknown;
}

// Directories the installer owns inside the user plugins root. The leading
// dot keeps them out of the Plugin Manager listing, and neither contains a
// plugin.json at its own root, so the backend's one-level discovery scan
// never loads them as plugins.
export const STAGING_DIR = '.feedback-staging';
export const BACKUP_DIR = '.feedback-backups';

const ID_PATTERN = /^[a-z][a-z0-9_-]*$/;
const INSTALL_DIR_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REPOSITORY_PATTERN = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const VERSION_PATTERN = /^(?:[0-9]+\.[0-9]+\.[0-9]+|[0-9]+\.[0-9]+\.[0-9]+-[0-9A-Za-z.-]+)$/;
const ARCHIVE_HOST = 'codeload.github.com';
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120000;

// Organization-owned sources must come from the matching GitHub owner; only
// `reviewed-community` entries may name a third-party owner, and those are
// still pinned by commit + hash in the release-locked catalog.
const SOURCE_OWNERS: Record<string, string | null> = {
    'get-flashbacks': 'get-flashbacks',
    'upstream-official': 'got-feedback',
    'reviewed-community': null,
};

const SAFE_PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Resolve a single directory name directly under the plugins root, or null
 * if the name could escape it (separators, traversal, leading dot/dash).
 * Shared with the git-based Plugin Manager paths.
 */
export function resolveSafePluginDir(pluginsDir: string, name: string): string | null {
    // `name` may arrive over IPC and may not be a string; guard before
    // path.resolve (which throws on non-string args).
    if (typeof name !== 'string' || !name || !SAFE_PLUGIN_NAME.test(name)) return null;
    const root = path.resolve(pluginsDir);
    const target = path.resolve(root, name);
    const rel = path.relative(root, target);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) {
        return null;
    }
    return target;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === 'string');
}

/**
 * Check the fields the installer relies on. The full schema is enforced at
 * release time by scripts/validate-plugin-catalog.js; this is the runtime
 * gate so a damaged resource file can never steer a download.
 */
export function validateCatalogEntry(entry: unknown): entry is CatalogEntry {
    if (!isObject(entry)) return false;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== 'string' || !ID_PATTERN.test(e.id)) return false;
    if (typeof e.installDir !== 'string' || !INSTALL_DIR_PATTERN.test(e.installDir)) return false;
    if (typeof e.name !== 'string' || !e.name) return false;
    if (typeof e.version !== 'string' || !VERSION_PATTERN.test(e.version)) return false;
    if (typeof e.commit !== 'string' || !COMMIT_PATTERN.test(e.commit)) return false;
    if (typeof e.archiveSha256 !== 'string' || !SHA256_PATTERN.test(e.archiveSha256)) return false;
    if (typeof e.source !== 'string' || !(e.source in SOURCE_OWNERS)) return false;
    if (!isStringArray(e.dependencies) || !isStringArray(e.conflicts)) return false;
    if (!isObject(e.size)) return false;
    const { downloadBytes, installedBytes } = e.size as Record<string, unknown>;
    if (!Number.isInteger(downloadBytes) || (downloadBytes as number) <= 0) return false;
    if ((downloadBytes as number) > MAX_DOWNLOAD_BYTES) return false;
    if (!Number.isInteger(installedBytes) || (installedBytes as number) < 0) return false;
    if ((installedBytes as number) > DEFAULT_ARCHIVE_LIMITS.maxTotalBytes) return false;
    if (typeof e.repository !== 'string') return false;
    const match = REPOSITORY_PATTERN.exec(e.repository);
    if (!match) return false;
    const requiredOwner = SOURCE_OWNERS[e.source as string];
    if (requiredOwner && match[1].toLowerCase() !== requiredOwner) return false;
    return true;
}

export interface Catalog {
    entries: CatalogEntry[];
    byId: Map<string, CatalogEntry>;
}

/** Load the bundled catalog. Invalid entries are dropped, never installed. */
export function loadCatalog(catalogPath: string): Catalog {
    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    } catch {
        throw new InstallError('The plugin catalog could not be read.');
    }
    if (!isObject(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) {
        throw new InstallError('The plugin catalog is not in a supported format.');
    }
    const entries: CatalogEntry[] = [];
    const byId = new Map<string, CatalogEntry>();
    const dirs = new Set<string>();
    for (const raw of parsed.entries) {
        if (!validateCatalogEntry(raw)) {
            console.warn('[plugin-installer] ignoring invalid catalog entry', isObject(raw) ? raw.id : raw);
            continue;
        }
        if (byId.has(raw.id) || dirs.has(raw.installDir.toLowerCase())) {
            console.warn('[plugin-installer] ignoring duplicate catalog entry', raw.id);
            continue;
        }
        entries.push(raw);
        byId.set(raw.id, raw);
        dirs.add(raw.installDir.toLowerCase());
    }
    return { entries, byId };
}

/** The only URL the installer will ever download for an entry. */
export function archiveUrlFor(entry: CatalogEntry): string {
    const match = REPOSITORY_PATTERN.exec(entry.repository);
    if (!match || !COMMIT_PATTERN.test(entry.commit)) {
        throw new InstallError(`${entry.name} has an invalid catalog source.`);
    }
    return `https://${ARCHIVE_HOST}/${match[1]}/${match[2]}/zip/${entry.commit}`;
}

export type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{
    ok: boolean;
    status: number;
    url: string;
    headers: { get(name: string): string | null };
    body: AsyncIterable<Uint8Array> | null;
}>;

/**
 * Download the pinned archive, refusing anything that is not HTTPS from the
 * codeload host, exceeds the pinned size, or fails the pinned SHA-256.
 */
export async function downloadArchive(entry: CatalogEntry, fetchImpl: FetchLike): Promise<Buffer> {
    const url = archiveUrlFor(entry);
    const expected = entry.size.downloadBytes;
    let response;
    try {
        response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    } catch {
        throw new InstallError(`Could not download ${entry.name}. Check your internet connection and try again.`);
    }
    let finalUrl: URL;
    try {
        finalUrl = new URL(response.url || url);
    } catch {
        throw new InstallError(`Download of ${entry.name} was redirected to an unexpected location.`);
    }
    if (finalUrl.protocol !== 'https:' || finalUrl.hostname !== ARCHIVE_HOST) {
        throw new InstallError(`Download of ${entry.name} was redirected to an unexpected location.`);
    }
    if (!response.ok || !response.body) {
        throw new InstallError(`Could not download ${entry.name} (HTTP ${response.status}).`);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > expected) {
        throw new InstallError(`The download of ${entry.name} is larger than the catalog allows.`);
    }
    const chunks: Buffer[] = [];
    let received = 0;
    const digest = crypto.createHash('sha256');
    try {
        for await (const chunk of response.body) {
            received += chunk.length;
            if (received > expected) {
                throw new InstallError(`The download of ${entry.name} is larger than the catalog allows.`);
            }
            const buf = Buffer.from(chunk);
            digest.update(buf);
            chunks.push(buf);
        }
    } catch (e) {
        if (e instanceof InstallError) throw e;
        throw new InstallError(`The download of ${entry.name} was interrupted. Please try again.`);
    }
    if (received !== expected) {
        throw new InstallError(`The download of ${entry.name} is incomplete or does not match the catalog.`);
    }
    if (digest.digest('hex') !== entry.archiveSha256) {
        throw new InstallError(`The download of ${entry.name} failed its integrity check and was discarded.`);
    }
    return Buffer.concat(chunks, received);
}

export interface PluginManifest {
    id: string;
    version: string;
    [key: string]: unknown;
}

/** Parse plugin.json bytes and require it to match the catalog entry. */
export function validateManifest(bytes: Buffer, entry: CatalogEntry): PluginManifest {
    if (bytes.length > MAX_MANIFEST_BYTES) throw new InstallError(`${entry.name} has an oversized plugin.json.`);
    let manifest: unknown;
    try {
        manifest = JSON.parse(bytes.toString('utf8'));
    } catch {
        throw new InstallError(`${entry.name} has an invalid plugin.json.`);
    }
    if (!isObject(manifest)) throw new InstallError(`${entry.name} has an invalid plugin.json.`);
    if (manifest.id !== entry.id) {
        throw new InstallError(`${entry.name}'s plugin.json does not match the catalog (unexpected plugin id).`);
    }
    if (manifest.version !== entry.version) {
        throw new InstallError(`${entry.name}'s plugin.json does not match the catalog (unexpected version).`);
    }
    if (typeof manifest.name !== 'string' || !manifest.name) {
        throw new InstallError(`${entry.name}'s plugin.json is missing a name.`);
    }
    return manifest as PluginManifest;
}

export interface VerifiedArchive {
    buffer: Buffer;
    prefix: string;
    manifest: PluginManifest;
}

/**
 * Structural + provenance checks on a downloaded archive: it must be the
 * pinned commit's GitHub archive (single `<repo>-<commit>/` root, commit in
 * the ZIP comment), expand to exactly the pinned size, and carry a root
 * plugin.json matching the entry.
 */
export function verifyArchive(buffer: Buffer, entry: CatalogEntry, limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS): VerifiedArchive {
    try {
        const archive = parseArchive(buffer, limits);
        const prefix = singleRootPrefix(archive);
        if (!prefix.endsWith(`-${entry.commit}/`)) {
            throw new InstallError(`The archive for ${entry.name} is not the pinned commit.`);
        }
        if (archive.comment && archive.comment !== entry.commit) {
            throw new InstallError(`The archive for ${entry.name} is not the pinned commit.`);
        }
        if (archive.totalUncompressedBytes !== entry.size.installedBytes) {
            throw new InstallError(`The archive for ${entry.name} does not match its catalog size.`);
        }
        const manifestEntry = archive.entries.find(e => e.name === `${prefix}plugin.json`);
        if (!manifestEntry || manifestEntry.isDirectory) {
            throw new InstallError(`${entry.name} does not contain a plugin.json.`);
        }
        const manifest = validateManifest(readEntryData(buffer, manifestEntry), entry);
        return { buffer, prefix, manifest };
    } catch (e) {
        if (e instanceof ArchiveError) throw new InstallError(`The archive for ${entry.name} was rejected: ${e.message}.`);
        throw e;
    }
}

// Remove the staging root once it is empty so a clean install leaves no
// trace; a non-empty root (concurrent work) is left alone.
function rmdirIfEmpty(dir: string): void {
    try { fs.rmdirSync(dir); } catch { /* not empty or already gone */ }
}

function rmQuiet(target: string): void {
    try {
        fs.rmSync(target, { recursive: true, force: true });
    } catch (e) {
        console.warn('[plugin-installer] cleanup failed', e);
    }
}

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);

/**
 * rename() with a short retry: on Windows a just-scanned file (antivirus,
 * indexer) can make a directory rename fail transiently with EPERM/EBUSY.
 */
export async function renameWithRetry(from: string, to: string, attempts = 5): Promise<void> {
    for (let i = 0; ; i++) {
        try {
            fs.renameSync(from, to);
            return;
        } catch (e: any) {
            if (i + 1 >= attempts || !RETRYABLE.has(e?.code)) throw e;
            await new Promise(r => setTimeout(r, 100 * 2 ** i));
        }
    }
}

export interface InstallerOptions {
    pluginsDir: string;
    fetch: FetchLike;
    /** Plugin ids shipped as `bundled: true` core plugins; these cannot be overridden. */
    protectedIds?: ReadonlySet<string>;
    limits?: ArchiveLimits;
}

export interface InstallOutcome {
    id: string;
    installDir: string;
    version: string;
    /** True when a previous version was moved to the backup slot. */
    hadPrevious: boolean;
}

function readInstalledManifest(dir: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
        return isObject(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/** Remove leftover staging directories from an interrupted install. */
export function cleanupStaging(pluginsDir: string): void {
    rmQuiet(path.join(pluginsDir, STAGING_DIR));
}

export function backupPathFor(pluginsDir: string, installDir: string): string {
    return path.join(pluginsDir, BACKUP_DIR, installDir);
}

export function hasBackup(pluginsDir: string, installDir: string): boolean {
    return fs.existsSync(backupPathFor(pluginsDir, installDir));
}

/**
 * Check that the destination slot is either free or holds an earlier copy of
 * the same plugin. Returns whether a previous installation exists.
 */
function inspectDestination(dest: string, entry: CatalogEntry): boolean {
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(dest);
    } catch (e: any) {
        if (e?.code === 'ENOENT') return false;
        throw new InstallError(`The install location for ${entry.name} could not be inspected.`);
    }
    if (stat.isSymbolicLink()) {
        throw new InstallError(
            `${entry.name} is linked to a development checkout. Remove the link before installing from the catalog.`,
        );
    }
    if (!stat.isDirectory()) {
        throw new InstallError(`The install location for ${entry.name} is occupied by a file.`);
    }
    const manifest = readInstalledManifest(dest);
    if (!manifest || manifest.id !== entry.id) {
        throw new InstallError(
            `The install location for ${entry.name} is used by a different plugin. Remove it before installing.`,
        );
    }
    return true;
}

/**
 * Download, verify, stage and activate one catalog entry on disk. On any
 * failure the live installation is left untouched (or restored) and the
 * staging directory removed. A replaced version is kept in the backup slot
 * until commitInstall() / rollbackInstall() decides its fate.
 */
export async function installCatalogEntry(entry: CatalogEntry, opts: InstallerOptions): Promise<InstallOutcome> {
    if (!validateCatalogEntry(entry)) throw new InstallError('That plugin is not available in the catalog.');
    if (opts.protectedIds?.has(entry.id)) {
        throw new InstallError(`${entry.name} ships with the application and cannot be replaced by a separate install.`);
    }
    const pluginsDir = path.resolve(opts.pluginsDir);
    const dest = resolveSafePluginDir(pluginsDir, entry.installDir);
    if (!dest) throw new InstallError(`${entry.name} has an invalid install location.`);

    // Fail fast on an unusable destination before spending a download.
    inspectDestination(dest, entry);

    const buffer = await downloadArchive(entry, opts.fetch);
    const verified = verifyArchive(buffer, entry, opts.limits);

    const stagingRoot = path.join(pluginsDir, STAGING_DIR);
    fs.mkdirSync(stagingRoot, { recursive: true });
    const work = fs.mkdtempSync(path.join(stagingRoot, `${entry.installDir}-`));
    const staged = path.join(work, 'plugin');
    try {
        try {
            extractArchive(verified.buffer, parseArchive(verified.buffer, opts.limits), verified.prefix, staged);
        } catch (e) {
            if (e instanceof ArchiveError) throw new InstallError(`The archive for ${entry.name} was rejected: ${e.message}.`);
            console.error('[plugin-installer] extraction failed', e);
            throw new InstallError(`${entry.name} could not be unpacked. Check free disk space and try again.`);
        }
        // Re-read the manifest from disk: what activates is what was written.
        const onDisk = readInstalledManifest(staged);
        if (!onDisk || onDisk.id !== entry.id || onDisk.version !== entry.version) {
            throw new InstallError(`${entry.name} could not be unpacked correctly.`);
        }

        // Re-check right before swapping: the slot may have changed while
        // downloading.
        const hadPrevious = inspectDestination(dest, entry);
        const backup = backupPathFor(pluginsDir, entry.installDir);
        let displaced: string | null = null;
        if (!hadPrevious) {
            // A backup without a live copy belongs to a plugin the user has
            // since removed; it must not be "restored" over this new install.
            rmQuiet(backup);
        } else {
            if (fs.existsSync(backup)) {
                // An earlier install was never confirmed; its backup is the
                // last version known to work, so keep it and discard the
                // unconfirmed copy currently in place.
                displaced = path.join(work, 'unconfirmed');
            } else {
                fs.mkdirSync(path.dirname(backup), { recursive: true });
                displaced = backup;
            }
            try {
                await renameWithRetry(dest, displaced);
            } catch (e) {
                console.error('[plugin-installer] could not move previous version aside', e);
                throw new InstallError(`${entry.name} is in use and could not be replaced. Close other apps using it and retry.`);
            }
        }
        try {
            await renameWithRetry(staged, dest);
        } catch (e) {
            console.error('[plugin-installer] activation rename failed', e);
            if (displaced) {
                try {
                    await renameWithRetry(displaced, dest);
                } catch (restoreError) {
                    console.error('[plugin-installer] could not restore previous version', restoreError);
                }
            }
            throw new InstallError(`${entry.name} could not be installed. Your previous version was kept.`);
        }
        return { id: entry.id, installDir: entry.installDir, version: entry.version, hadPrevious };
    } finally {
        rmQuiet(work);
        rmdirIfEmpty(stagingRoot);
    }
}

/** Activation succeeded: drop the backup of the previous version. */
export function commitInstall(pluginsDir: string, installDir: string): void {
    if (!INSTALL_DIR_PATTERN.test(installDir)) return;
    rmQuiet(backupPathFor(path.resolve(pluginsDir), installDir));
}

/**
 * Activation failed: restore the previous version from the backup slot, or
 * remove the new install entirely when there was no previous version (so a
 * failed activation leaves no half-working plugin behind).
 */
export async function rollbackInstall(pluginsDir: string, installDir: string): Promise<'restored' | 'removed'> {
    const root = path.resolve(pluginsDir);
    const dest = resolveSafePluginDir(root, installDir);
    if (!dest || !INSTALL_DIR_PATTERN.test(installDir)) throw new InstallError('Invalid plugin.');
    const backup = backupPathFor(root, installDir);
    if (!fs.existsSync(backup)) {
        rmQuiet(dest);
        return 'removed';
    }
    const stagingRoot = path.join(root, STAGING_DIR);
    fs.mkdirSync(stagingRoot, { recursive: true });
    const work = fs.mkdtempSync(path.join(stagingRoot, `${installDir}-rollback-`));
    try {
        const failed = path.join(work, 'failed');
        if (fs.existsSync(dest)) await renameWithRetry(dest, failed);
        try {
            await renameWithRetry(backup, dest);
        } catch (e) {
            if (fs.existsSync(failed)) await renameWithRetry(failed, dest).catch(() => undefined);
            console.error('[plugin-installer] rollback failed', e);
            throw new InstallError('The previous version could not be restored.');
        }
        return 'restored';
    } finally {
        rmQuiet(work);
        rmdirIfEmpty(stagingRoot);
    }
}

export interface BatchItemResult {
    id: string;
    name: string;
    success: boolean;
    message: string;
}

export interface ActivationStatus {
    ok: boolean;
    message?: string;
}

export interface BatchOptions extends InstallerOptions {
    /** Ids of plugins already present in the user or core plugin dirs. */
    installedIds: ReadonlySet<string>;
    /**
     * Restart the backend once and report per-plugin activation. Omit to skip
     * activation (e.g. backend not running); backups are then kept until the
     * next successful activation check or an explicit rollback.
     */
    activate?: (outcomes: InstallOutcome[]) => Promise<Map<string, ActivationStatus>>;
    /** Restart again after rolling back failed activations. */
    restartAfterRollback?: () => Promise<void>;
}

/**
 * Install several catalog plugins. Each entry is installed independently —
 * one failure never affects the others — and the backend is restarted once
 * after all disk operations (plus once more only if a rollback was needed).
 */
export async function installCatalogBatch(ids: string[], catalog: Catalog, opts: BatchOptions): Promise<BatchItemResult[]> {
    const results: BatchItemResult[] = [];
    const unique = [...new Set(Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : [])];
    const selected = new Set(unique);
    const outcomes: InstallOutcome[] = [];

    for (const id of unique) {
        const entry = catalog.byId.get(id);
        if (!entry) {
            results.push({ id, name: id, success: false, message: 'That plugin is not available in the catalog.' });
            continue;
        }
        const missing = entry.dependencies.filter(dep => !selected.has(dep) && !opts.installedIds.has(dep));
        if (missing.length) {
            const names = missing.map(dep => catalog.byId.get(dep)?.name || dep).join(', ');
            results.push({ id, name: entry.name, success: false, message: `${entry.name} requires ${names}.` });
            continue;
        }
        const conflicting = entry.conflicts.filter(c => selected.has(c) || opts.installedIds.has(c));
        if (conflicting.length) {
            const names = conflicting.map(c => catalog.byId.get(c)?.name || c).join(', ');
            results.push({ id, name: entry.name, success: false, message: `${entry.name} conflicts with ${names}.` });
            continue;
        }
        try {
            outcomes.push(await installCatalogEntry(entry, opts));
            results.push({ id, name: entry.name, success: true, message: `Installed ${entry.name} ${entry.version}.` });
        } catch (e) {
            const message = e instanceof InstallError ? e.message : `${entry.name} could not be installed.`;
            if (!(e instanceof InstallError)) console.error('[plugin-installer] unexpected install failure', e);
            results.push({ id, name: entry.name, success: false, message });
        }
    }

    if (!outcomes.length || !opts.activate) return results;

    let statuses: Map<string, ActivationStatus>;
    try {
        statuses = await opts.activate(outcomes);
    } catch (e) {
        console.error('[plugin-installer] activation check failed', e);
        for (const outcome of outcomes) {
            const result = results.find(r => r.id === outcome.id);
            if (result) result.message += ' Restart the app to finish activating it.';
        }
        return results;
    }

    let rolledBack = false;
    for (const outcome of outcomes) {
        const result = results.find(r => r.id === outcome.id)!;
        const status = statuses.get(outcome.id);
        if (status?.ok) {
            commitInstall(opts.pluginsDir, outcome.installDir);
            continue;
        }
        rolledBack = true;
        let restoredText = 'It was removed.';
        try {
            const how = await rollbackInstall(opts.pluginsDir, outcome.installDir);
            if (how === 'restored') restoredText = 'The previous version was restored.';
        } catch (e) {
            restoredText = e instanceof InstallError ? e.message : 'The previous version could not be restored.';
        }
        result.success = false;
        result.message = `${result.name} failed to start${status?.message ? ` (${status.message})` : ''}. ${restoredText}`;
    }
    if (rolledBack && opts.restartAfterRollback) {
        try {
            await opts.restartAfterRollback();
        } catch (e) {
            console.error('[plugin-installer] restart after rollback failed', e);
        }
    }
    return results;
}
