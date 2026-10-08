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

/**
 * User-facing install failure. Messages never contain filesystem paths.
 *
 * `networkRequired` singles out the failures a connect-only fix can retry —
 * the renderer reports those as "a connection is required" rather than as a
 * broken install, and leaves the selection in place for another attempt once
 * the network is back. Server rejections (auth, 404, size, integrity) are
 * install failures, not network failures, and stay unflagged.
 */
export class InstallError extends Error {
    readonly networkRequired: boolean;
    constructor(message: string, options: { networkRequired?: boolean } = {}) {
        super(message);
        this.name = 'InstallError';
        this.networkRequired = options.networkRequired === true;
    }
}

/** The catalog trust classes, and the GitHub owner each one requires. */
export type CatalogSource = 'get-flashbacks' | 'upstream-official' | 'reviewed-community';

/** Lifecycle status the catalog may attach to an entry. Absent, an entry is
 *  `active`. Carried by the release-locked catalog so the desktop can stop
 *  offering a plugin before it is removed (5/6). */
export type CatalogEntryStatus = 'active' | 'deprecated' | 'withdrawn' | 'security-blocked';
/** Allowed values for `CatalogEntry.status`. Exported so the lifecycle rule and
 *  the runtime validator answer the same question from one list. */
export const CATALOG_STATUSES: ReadonlySet<string> = new Set([
    'active', 'deprecated', 'withdrawn', 'security-blocked',
]);

export interface CatalogEntry {
    id: string;
    installDir: string;
    name: string;
    repository: string;
    version: string;
    commit: string;
    archiveSha256: string;
    source: CatalogSource;
    /** Catalog lifecycle status; absent defaults to `active`. */
    status?: CatalogEntryStatus;
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
const SOURCE_OWNERS: Record<CatalogSource, string | null> = {
    'get-flashbacks': 'get-flashbacks',
    'upstream-official': 'got-feedback',
    'reviewed-community': null,
};

/**
 * A trust class this build knows. Exported so the installed-state record's pin
 * validation uses this table rather than a second copy of the list that could
 * drift from it.
 */
export function isCatalogSource(value: unknown): value is CatalogSource {
    return typeof value === 'string' && Object.hasOwn(SOURCE_OWNERS, value);
}

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
    if (!isCatalogSource(e.source)) return false;
    if (!isStringArray(e.dependencies) || !isStringArray(e.conflicts)) return false;
    if (!isObject(e.size)) return false;
    const { downloadBytes, installedBytes } = e.size as Record<string, unknown>;
    if (!Number.isInteger(downloadBytes) || (downloadBytes as number) <= 0) return false;
    if ((downloadBytes as number) > MAX_DOWNLOAD_BYTES) return false;
    if (!Number.isInteger(installedBytes) || (installedBytes as number) < 0) return false;
    if ((installedBytes as number) > DEFAULT_ARCHIVE_LIMITS.maxTotalBytes) return false;
    const parts = repositoryParts(e.repository);
    if (!parts) return false;
    const requiredOwner = SOURCE_OWNERS[e.source];
    if (requiredOwner && parts.owner.toLowerCase() !== requiredOwner) return false;
    if (e.status !== undefined && !(typeof e.status === 'string' && CATALOG_STATUSES.has(e.status))) return false;
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
 * Progress tick for one plugin of a batch install. `receivedBytes`/`totalBytes`
 * are only meaningful for the `download` phase; the pinned `totalBytes` is the
 * catalog's exact archive size, so the ratio is exact rather than a
 * content-length guess.
 */
export interface InstallProgress {
    id: string;
    name: string;
    phase: 'start' | 'download' | 'installed' | 'failed' | 'cancelled';
    receivedBytes?: number;
    totalBytes?: number;
}

export interface DownloadOptions {
    /** Called as bytes arrive; the callback must not throw. */
    onProgress?: (receivedBytes: number, totalBytes: number) => void;
    /** Aborts the transfer (the caller's "cancel" path). */
    signal?: AbortSignal;
}

function cancelledError(entry: CatalogEntry): InstallError {
    return new InstallError(`The download of ${entry.name} was cancelled.`);
}

/**
 * Combine the per-download timeout with a caller-supplied cancel signal. Done
 * here rather than at the call sites so no caller can pass a signal that
 * silently replaces the timeout (an unbounded download).
 */
function downloadSignal(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
    if (!signal) return timeout;
    if (signal.aborted) return AbortSignal.abort();
    if (typeof AbortSignal.any === 'function') return AbortSignal.any([timeout, signal]);
    return timeout;
}

/**
 * Download the pinned archive, refusing anything that is not HTTPS from the
 * codeload host, exceeds the pinned size, or fails the pinned SHA-256.
 */
export async function downloadArchive(
    entry: CatalogEntry,
    fetchImpl: FetchLike,
    opts: DownloadOptions = {},
): Promise<Buffer> {
    const url = archiveUrlFor(entry);
    const expected = entry.size.downloadBytes;
    let response;
    try {
        response = await fetchImpl(url, { redirect: 'follow', signal: downloadSignal(opts.signal) });
    } catch {
        if (opts.signal?.aborted) throw cancelledError(entry);
        throw new InstallError(`Could not download ${entry.name}. Check your internet connection and try again.`, { networkRequired: true });
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
            if (opts.signal?.aborted) throw cancelledError(entry);
            received += chunk.length;
            if (received > expected) {
                throw new InstallError(`The download of ${entry.name} is larger than the catalog allows.`);
            }
            const buf = Buffer.from(chunk);
            digest.update(buf);
            chunks.push(buf);
            try {
                opts.onProgress?.(received, expected);
            } catch {
                // A faulty progress listener must never fail an install.
            }
        }
    } catch (e) {
        if (e instanceof InstallError) throw e;
        if (opts.signal?.aborted) throw cancelledError(entry);
        // A stream that dies mid-transfer is a connection problem until the
        // retry says otherwise, so it gets the same hint as a refused socket.
        throw new InstallError(`The download of ${entry.name} was interrupted. Please try again.`, { networkRequired: true });
    }
    if (opts.signal?.aborted) throw cancelledError(entry);
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

/** The refusal for an installer-owned directory the installer will not touch. */
function unusableRoot(where: string): InstallError {
    return new InstallError(`The ${where} is not usable. Remove it and retry.`);
}

/**
 * Prepare one of the installer's own directories, refusing anything that is not
 * a real directory: a symlink there would redirect a rename outside the plugins
 * root. `where` names the location in the message the user sees.
 */
function ensureRealDirectory(dir: string, where: string): void {
    try {
        fs.mkdirSync(dir, { recursive: true });
        const stat = fs.lstatSync(dir);
        if (stat.isDirectory() && !stat.isSymbolicLink()) return;
    } catch (e) {
        console.error('[plugin-installer] could not prepare installer directory', e);
    }
    throw unusableRoot(where);
}

/**
 * The same refusal without creating anything, for a path about to be read or
 * removed rather than written: a root that is not there has nothing under it,
 * while a root that is a symlink or a file would send the operation outside the
 * plugins root — `rename` and `rmSync` both resolve every component but the last.
 */
function requireRealRoot(dir: string, where: string): void {
    if (fs.existsSync(dir) && !isRealDirectory(dir)) throw unusableRoot(where);
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
    /** Progress ticks for this plugin. Callbacks must not throw. */
    onProgress?: (progress: InstallProgress) => void;
    /** Cancels the transfer; the live installation is left untouched. */
    signal?: AbortSignal;
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
 * Version the copy on disk claims in its own manifest, or null when no
 * readable manifest vouches for it. Used after a rollback to identify the
 * restored copy: a second install over an unconfirmed copy keeps the OLD
 * backup and discards the intermediate copy, so the record's history alone
 * cannot say what just landed on disk.
 */
export function installedVersionOnDisk(pluginsDir: string, installDir: string): string | null {
    const root = path.resolve(pluginsDir);
    const dir = resolveSafePluginDir(root, installDir);
    if (!dir || !INSTALL_DIR_PATTERN.test(installDir)) return null;
    const version = readInstalledManifest(dir)?.version;
    return typeof version === 'string' && isPluginVersion(version) ? version : null;
}

// ── Disabling, re-enabling and removing a copy ──────────────────────────────

/**
 * Where a disabled copy waits. Same shape as the backup slot: a dot-prefixed
 * directory directly under the plugins root, holding one directory per install
 * dir. The backend's discovery scan is one level deep and skips dot-prefixed
 * names, so a plugin parked here is invisible to it — which is the whole point of
 * disabling, and why this cannot be `plugins/<dir>/disabled`.
 */
export const DISABLED_DIR = '.feedback-disabled';

/**
 * Parked slot for a disabled copy. `installDir` is validated against the
 * catalog's install-dir pattern (a single safe segment); anything else throws,
 * so no caller can build a path outside the disabled root by skipping validation.
 */
export function disabledPathFor(pluginsDir: string, installDir: string): string {
    if (typeof installDir !== 'string' || !INSTALL_DIR_PATTERN.test(installDir)) {
        throw new InstallError('Invalid plugin.');
    }
    // installDir is checked against INSTALL_DIR_PATTERN above
    const target = path.join(path.resolve(pluginsDir), DISABLED_DIR, installDir);
    const rel = path.relative(path.resolve(pluginsDir, DISABLED_DIR), target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new InstallError('Invalid plugin.');
    return target;
}

/**
 * True when `dir` is a real directory — not a symlink, not a file. Anything
 * squatting in one of the installer's own slots is a state the installer refuses
 * to act on rather than treats as a plugin.
 */
function isRealDirectory(dir: string): boolean {
    try {
        const stat = fs.lstatSync(dir);
        return stat.isDirectory() && !stat.isSymbolicLink();
    } catch {
        return false;
    }
}

/** True when the copy is parked in the disabled slot. */
export function isPluginDisabled(pluginsDir: string, installDir: string): boolean {
    return isRealDirectory(disabledPathFor(pluginsDir, installDir));
}

/** Every place a copy of `installDir` can be on disk, live and parked. */
function sourcePathsFor(pluginsDir: string, installDir: string): { live: string; disabled: string; backup: string } {
    const root = path.resolve(pluginsDir);
    const live = resolveSafePluginDir(root, installDir);
    if (!live) throw new InstallError('Invalid plugin.');
    return { live, disabled: disabledPathFor(root, installDir), backup: backupPathFor(root, installDir) };
}

/** The installer's own directory a parked copy lives in. */
function disabledRootFor(pluginsDir: string): string {
    // literal directory name under the trusted plugins root
    return path.join(path.resolve(pluginsDir), DISABLED_DIR);
}

/**
 * The message a failed move reports. A cross-device rename is not a lock: the two
 * locations are on different volumes, or the filesystem does not support
 * renaming a directory at all, so retrying cannot succeed. Naming that is the
 * only honest answer, rather than telling the user to close an app that is
 * holding nothing.
 */
function moveFailure(e: any, verb: 'disabled' | 'enabled'): InstallError {
    if (e?.code === 'EXDEV') {
        return new InstallError(`This plugin could not be ${verb}: the plugins folder and its ${DISABLED_DIR} location are on different volumes.`);
    }
    return new InstallError(`This plugin is in use and could not be ${verb}. Close other apps using it and retry.`);
}

/**
 * Disable a copy: move it out of the backend's scan into the disabled slot. Its
 * files, and anything the backend already wrote for it, are left alone, so
 * re-enabling is a move back rather than a reinstall.
 *
 * The backup slot is dropped on the way in: it holds a version from before the
 * disable, which is not something "restore previous version" should offer once
 * the user has changed the state deliberately.
 */
export async function disablePlugin(pluginsDir: string, installDir: string): Promise<void> {
    const { live, disabled, backup } = sourcePathsFor(pluginsDir, installDir);
    // A slot holding something other than a real directory is squatting, and must
    // not pass for an already-parked copy: reporting success here would tell the
    // user the plugin is disabled while it is still live and loaded.
    if (!isRealDirectory(disabled) && fs.existsSync(disabled)) {
        throw new InstallError(`The disabled location for this plugin (${DISABLED_DIR}) is occupied by a file or link. Remove it and retry.`);
    }
    if (isPluginDisabled(pluginsDir, installDir)) {
        // Already parked. Refuse rather than silently report success: the caller
        // is answering a request to disable a copy that is live on disk.
        if (fs.existsSync(live)) {
            throw new InstallError('This plugin is present both installed and disabled. Restart the app and retry.');
        }
        rmQuiet(backup);
        return;
    }
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(live);
    } catch (e: any) {
        if (e?.code === 'ENOENT') throw new InstallError('This plugin is not installed.');
        throw new InstallError('This plugin could not be disabled.');
    }
    // A symlinked checkout is the developer's own working tree; moving it aside
    // would take their uncommitted work with it.
    if (stat.isSymbolicLink()) {
        throw new InstallError('This plugin is linked to a development checkout, so it cannot be disabled. Unlink it first.');
    }
    if (!stat.isDirectory()) throw new InstallError('The install location for this plugin is occupied by a file.');
    ensureRealDirectory(disabledRootFor(pluginsDir), `disabled-plugins location (${DISABLED_DIR})`);
    try {
        await renameWithRetry(live, disabled);
    } catch (e) {
        console.error('[plugin-installer] could not disable plugin', e);
        throw moveFailure(e, 'disabled');
    }
    rmQuiet(backup);
}

/**
 * Move a disabled copy back into the backend's scan. Nothing is downloaded or
 * verified: these are the same bytes that were verified when they were installed.
 *
 * Re-enabling does not download anything, so it cannot be constrained by the
 * state the record claims. The directory itself is the authority: if a copy is
 * parked it is moved back, and if one is live the user is told so rather than
 * having their working copy replaced.
 */
export async function enablePlugin(pluginsDir: string, installDir: string): Promise<void> {
    const { live, disabled } = sourcePathsFor(pluginsDir, installDir);
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(disabled);
    } catch (e: any) {
        if (e?.code === 'ENOENT') throw new InstallError('This plugin is not disabled.');
        throw new InstallError('This plugin could not be enabled.');
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new InstallError('The disabled copy of this plugin could not be read.');
    }
    if (fs.existsSync(live)) {
        throw new InstallError('A copy of this plugin is already installed. Remove it before enabling this one.');
    }
    // The lstat above only inspected the slot itself: it resolved the disabled root
    // as an ordinary parent, so a symlinked root would pass and hand the rename a
    // directory from outside the plugins root. Disabling checks this; enabling
    // moves into the live, backend-scanned slot, so it has to as well.
    ensureRealDirectory(disabledRootFor(pluginsDir), `disabled-plugins location (${DISABLED_DIR})`);
    try {
        await renameWithRetry(disabled, live);
    } catch (e) {
        console.error('[plugin-installer] could not enable plugin', e);
        throw moveFailure(e, 'enabled');
    }
    rmdirIfEmpty(disabledRootFor(pluginsDir));
}

/** What a removal actually deleted, so the caller can say so honestly. */
export interface RemovedSource {
    live: boolean;
    disabled: boolean;
    backup: boolean;
}

/**
 * Delete every copy of a plugin from disk: the live directory, the disabled slot
 * and the backup. `fs.rmSync` on a symlinked entry removes the link and not its
 * target, so a developer's linked checkout cannot be deleted through this.
 */
export function removePluginSource(pluginsDir: string, installDir: string): RemovedSource {
    const { live, disabled, backup } = sourcePathsFor(pluginsDir, installDir);
    // The recursive removes below resolve every path component but the last, so a
    // disabled or backup root that is a symlink would delete whatever it points at
    // instead. Both roots are the installer's own, and a copy is removed in full
    // or not at all — half an uninstall is the state neither the record nor the
    // screen can describe.
    requireRealRoot(disabledRootFor(pluginsDir), `disabled-plugins location (${DISABLED_DIR})`);
    requireRealRoot(path.dirname(backup), `backup location (${BACKUP_DIR})`);
    const removed: RemovedSource = {
        live: fs.existsSync(live),
        disabled: fs.existsSync(disabled),
        backup: fs.existsSync(backup),
    };
    if (!removed.live && !removed.disabled && !removed.backup) {
        throw new InstallError('This plugin is not installed.');
    }
    rmQuiet(live);
    rmQuiet(disabled);
    rmQuiet(backup);
    rmdirIfEmpty(disabledRootFor(pluginsDir));
    return removed;
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

    const buffer = await downloadArchive(entry, opts.fetch, {
        signal: opts.signal,
        onProgress: opts.onProgress
            ? (received, total) => opts.onProgress!({ id: entry.id, name: entry.name, phase: 'download', receivedBytes: received, totalBytes: total })
            : undefined,
    });
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
        ensureRealDirectory(path.dirname(backup), `backup location for ${entry.name} (${BACKUP_DIR})`);
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
    /** If true, this failure was a connectivity problem and the item is retryable. */
    networkRequired?: boolean;
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

const CANCELLED_MESSAGE = 'Not installed — the batch was cancelled.';

/** Emit a progress tick without letting a faulty listener break the batch. */
function emit(opts: BatchOptions, progress: InstallProgress): void {
    try {
        opts.onProgress?.(progress);
    } catch (e) {
        console.warn('[plugin-installer] progress listener failed', e);
    }
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
        // Cancellation is honoured between items too, so a cancel during plugin
        // 3 of 8 does not silently continue through the remaining downloads.
        // Whatever already landed is still activated below, so the app is left
        // in a consistent state and the rest can be resumed later.
        if (opts.signal?.aborted) {
            results.push({ id, name: entry.name, success: false, message: CANCELLED_MESSAGE });
            emit(opts, { id, name: entry.name, phase: 'cancelled' });
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
            emit(opts, { id, name: entry.name, phase: 'start', totalBytes: entry.size.downloadBytes });
            outcomes.push(await installCatalogEntry(entry, opts));
            installedNow.add(entry.id);
            results.push({ id, name: entry.name, success: true, message: `Installed ${entry.name} ${entry.version}.` });
            emit(opts, { id, name: entry.name, phase: 'installed', receivedBytes: entry.size.downloadBytes, totalBytes: entry.size.downloadBytes });
        } catch (e) {
            const cancelled = opts.signal?.aborted === true;
            const message = cancelled
                ? CANCELLED_MESSAGE
                : e instanceof InstallError ? e.message : `${entry.name} could not be installed.`;
            if (!cancelled && !(e instanceof InstallError)) console.error('[plugin-installer] unexpected install failure', e);
            results.push({
                id,
                name: entry.name,
                success: false,
                message,
                ...(e instanceof InstallError && e.networkRequired && !cancelled ? { networkRequired: true } : {}),
            });
            emit(opts, { id, name: entry.name, phase: cancelled ? 'cancelled' : 'failed' });
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
