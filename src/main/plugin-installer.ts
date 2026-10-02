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
    ParsedArchive,
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

// Field-level checks for the shapes the catalog, its JSON schema and
// scripts/validate-plugin-catalog.js all describe. They are exported so the
// installed-state record (plugin-installed-state.ts) validates against the same
// patterns instead of a second copy that can drift.
export function isPluginId(value: unknown): boolean {
    return typeof value === 'string' && ID_PATTERN.test(value);
}

export function isInstallDirName(value: unknown): boolean {
    return typeof value === 'string' && INSTALL_DIR_PATTERN.test(value);
}

export function isPluginVersion(value: unknown): boolean {
    return typeof value === 'string' && VERSION_PATTERN.test(value);
}

export function isCommitSha(value: unknown): boolean {
    return typeof value === 'string' && COMMIT_PATTERN.test(value);
}

export function isArchiveDigest(value: unknown): boolean {
    return typeof value === 'string' && SHA256_PATTERN.test(value);
}

/**
 * Owner and repository of an approved `https://github.com/OWNER/REPO` source,
 * or null for anything else: plain http, another host, a path that escapes the
 * repository, or a value that is not a string at all.
 */
export function repositoryParts(repository: unknown): { owner: string; repo: string } | null {
    if (typeof repository !== 'string') return null;
    const match = REPOSITORY_PATTERN.exec(repository);
    return match ? { owner: match[1], repo: match[2] } : null;
}

export function isRepositoryUrl(value: unknown): boolean {
    return repositoryParts(value) !== null;
}

/**
 * Resolve a single directory name directly under the plugins root, or null
 * if the name could escape it (separators, traversal, leading dot/dash).
 * Shared with the git-based Plugin Manager paths.
 */
export function resolveSafePluginDir(pluginsDir: string, name: string): string | null {
    // `name` may arrive over IPC and may not be a string; guard before
    // path.resolve (which throws on non-string args).
    if (typeof name !== 'string' || !name || !SAFE_PLUGIN_NAME.test(name)) return null;
    // name matched SAFE_PLUGIN_NAME above; containment is re-checked below
    const root = path.resolve(pluginsDir);
    // name matched SAFE_PLUGIN_NAME above; containment is re-checked below
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
    if (!isPluginId(e.id)) return false;
    if (!isInstallDirName(e.installDir)) return false;
    if (typeof e.name !== 'string' || !e.name) return false;
    if (!isPluginVersion(e.version)) return false;
    if (!isCommitSha(e.commit)) return false;
    if (!isArchiveDigest(e.archiveSha256)) return false;
    if (typeof e.source !== 'string' || !(e.source in SOURCE_OWNERS)) return false;
    if (!isStringArray(e.dependencies) || !isStringArray(e.conflicts)) return false;
    if (!isObject(e.size)) return false;
    const { downloadBytes, installedBytes } = e.size as Record<string, unknown>;
    if (!Number.isInteger(downloadBytes) || (downloadBytes as number) <= 0) return false;
    if ((downloadBytes as number) > MAX_DOWNLOAD_BYTES) return false;
    if (!Number.isInteger(installedBytes) || (installedBytes as number) < 0) return false;
    if ((installedBytes as number) > DEFAULT_ARCHIVE_LIMITS.maxTotalBytes) return false;
    const parts = repositoryParts(e.repository);
    if (!parts) return false;
    const requiredOwner = SOURCE_OWNERS[e.source as string];
    if (requiredOwner && parts.owner.toLowerCase() !== requiredOwner) return false;
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
    const parts = repositoryParts(entry.repository);
    if (!parts || !isCommitSha(entry.commit)) {
        throw new InstallError(`${entry.name} has an invalid catalog source.`);
    }
    return `https://${ARCHIVE_HOST}/${parts.owner}/${parts.repo}/zip/${entry.commit}`;
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
    archive: ParsedArchive;
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
        return { buffer, archive, prefix, manifest };
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

/**
 * Create `dir` if missing and require it to be a real directory. A symlink
 * (or file) squatting on an installer-owned directory would otherwise
 * redirect renames outside the plugins root.
 */
function ensureRealDirectory(dir: string, label: string): void {
    try {
        fs.mkdirSync(dir, { recursive: true });
        const stat = fs.lstatSync(dir);
        if (stat.isDirectory() && !stat.isSymbolicLink()) return;
    } catch (e) {
        console.error('[plugin-installer] could not prepare installer directory', e);
    }
    throw new InstallError(`The backup location for ${label} is not usable. Remove the ${BACKUP_DIR} folder and retry.`);
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
        // dir is a validated plugin directory; the file name is a literal
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
        return isObject(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/** Remove leftover staging directories from an interrupted install. */
export function cleanupStaging(pluginsDir: string): void {
    // literal directory name under the trusted plugins root
    rmQuiet(path.join(pluginsDir, STAGING_DIR));
}

/**
 * Backup slot for an install directory. `installDir` must match the catalog's
 * install-dir pattern (a single Python-safe segment); anything else throws, so
 * no caller can build a path outside the backup root by skipping validation.
 */
export function backupPathFor(pluginsDir: string, installDir: string): string {
    if (typeof installDir !== 'string' || !INSTALL_DIR_PATTERN.test(installDir)) {
        throw new InstallError('Invalid plugin.');
    }
    // installDir is checked against INSTALL_DIR_PATTERN above
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
    // pluginsDir comes from app.getPath, not from user input
    const pluginsDir = path.resolve(opts.pluginsDir);
    const dest = resolveSafePluginDir(pluginsDir, entry.installDir);
    if (!dest) throw new InstallError(`${entry.name} has an invalid install location.`);

    // Fail fast on an unusable destination before spending a download.
    inspectDestination(dest, entry);

    const buffer = await downloadArchive(entry, opts.fetch);
    const verified = verifyArchive(buffer, entry, opts.limits);

    // literal directory name under the trusted plugins root
    const stagingRoot = path.join(pluginsDir, STAGING_DIR);
    fs.mkdirSync(stagingRoot, { recursive: true });
    // entry.installDir was validated by validateCatalogEntry
    const work = fs.mkdtempSync(path.join(stagingRoot, `${entry.installDir}-`));
    // literal segment under a private mkdtemp directory
    const staged = path.join(work, 'plugin');
    try {
        try {
            extractArchive(verified.buffer, verified.archive, verified.prefix, staged);
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
        // Both branches below write through the backup root (rmSync follows
        // symlinks), so it is validated once, before either of them runs.
        ensureRealDirectory(path.dirname(backup), entry.name);
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
                // literal segment under a private mkdtemp directory
                displaced = path.join(work, 'unconfirmed');
            } else {
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
            let restoreFailed = false;
            if (displaced) {
                try {
                    await renameWithRetry(displaced, dest);
                } catch (restoreError) {
                    restoreFailed = true;
                    console.error('[plugin-installer] could not restore previous version', restoreError);
                }
            }
            // Only claim the previous version survived when it demonstrably
            // did: the restore landed, or the backup slot still holds a copy
            // the Plugin Manager can put back (that is what `canRollback`
            // reports).
            if (hadPrevious && !restoreFailed) {
                throw new InstallError(`${entry.name} could not be installed. Your previous version was kept.`);
            }
            if (hadPrevious && hasBackup(pluginsDir, entry.installDir)) {
                throw new InstallError(
                    `${entry.name} could not be installed, and the version it replaced could not be put back. `
                    + 'Use "Restore previous version" in the Plugin Manager to recover it.',
                );
            }
            throw new InstallError(`${entry.name} could not be installed.`);
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
    // pluginsDir is trusted; installDir is validated inside backupPathFor
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
    // literal directory name under the trusted plugins root
    const stagingRoot = path.join(root, STAGING_DIR);
    fs.mkdirSync(stagingRoot, { recursive: true });
    // installDir was validated at the top of this function
    const work = fs.mkdtempSync(path.join(stagingRoot, `${installDir}-rollback-`));
    try {
        // literal segment under a private mkdtemp directory
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
    /** False only when activation was never confirmed by the backend probe. */
    confirmed?: boolean;
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
    const requested = [...new Set(Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : [])];
    const selected = new Set(requested);
    const outcomes: InstallOutcome[] = [];
    // Plugins that actually landed on disk during this batch. Dependencies and
    // conflicts are judged against this, not against what was merely requested,
    // so a failed dependency is never papered over by its dependent installing.
    const installedNow = new Set<string>();

    // Install dependencies before their dependents (the catalog validator
    // guarantees the graph is acyclic; `visited` also guards a damaged one).
    const unique: string[] = [];
    const visited = new Set<string>();
    const visit = (id: string): void => {
        if (visited.has(id)) return;
        visited.add(id);
        for (const dep of catalog.byId.get(id)?.dependencies ?? []) if (selected.has(dep)) visit(dep);
        unique.push(id);
    };
    requested.forEach(visit);

    for (const id of unique) {
        const entry = catalog.byId.get(id);
        if (!entry) {
            results.push({ id, name: id, success: false, message: 'That plugin is not available in the catalog.' });
            continue;
        }
        const missing = entry.dependencies.filter(dep => !installedNow.has(dep) && !opts.installedIds.has(dep));
        if (missing.length) {
            const names = missing.map(dep => catalog.byId.get(dep)?.name || dep).join(', ');
            const failedHere = missing.some(dep => selected.has(dep));
            const reason = failedHere ? `${entry.name} requires ${names}, which could not be installed.` : `${entry.name} requires ${names}.`;
            results.push({ id, name: entry.name, success: false, message: reason });
            continue;
        }
        // A conflict is fatal only for the entry that would come second, so
        // selecting a conflicting pair installs one and explains the other
        // instead of rejecting both. Conflicts may be declared one-sidedly, so
        // both arms read the same set — already on disk plus installed by this
        // batch — rather than assuming the declaration is symmetric.
        const live = new Set([...opts.installedIds, ...installedNow]);
        const conflicting = [
            ...entry.conflicts.filter(c => live.has(c)),
            ...[...live].filter(other => catalog.byId.get(other)?.conflicts.includes(entry.id)),
        ];
        if (conflicting.length) {
            const names = [...new Set(conflicting)].map(c => catalog.byId.get(c)?.name || c).join(', ');
            results.push({ id, name: entry.name, success: false, message: `${entry.name} conflicts with ${names}. Install only one of them.` });
            continue;
        }
        try {
            outcomes.push(await installCatalogEntry(entry, opts));
            installedNow.add(entry.id);
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
        if (status?.ok && status.confirmed !== false) {
            commitInstall(opts.pluginsDir, outcome.installDir);
            continue;
        }
        if (status?.ok) {
            // Unconfirmed: keep the backup so a later confirmation can still
            // decide to commit, and report the uncertainty rather than deleting
            // the previous version on the strength of a status nobody observed.
            result.message = `${result.name} is still installing dependencies; activation was not confirmed by the server.`
                + ' Restart the app to re-check activation.';
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
