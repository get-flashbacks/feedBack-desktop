// Installed-state record for optional plugins (issue #20, lifecycle 1/6 of #6).
//
// Every later lifecycle operation — update / pin / downgrade / disable /
// uninstall (2/6), bundled-vs-override precedence (3/6), rollback (4/6) and the
// desktop-update compatibility preflight (5/6) — reads or writes this file
// first, so it is the single record of what is installed, where it came from,
// and which catalog revision it was resolved against.
//
// The record lives in the desktop's own state directory
// (app.getPath('userData')), not in the plugins dir: it is desktop-owned state
// *about* the plugins dir, and the backend scans that dir for plugins.
//
// Shape and behaviour:
//   * versioned via `schemaVersion`; a record written by a newer app is read as
//     "unsupported" and never overwritten, so a downgrade cannot destroy
//     provenance it does not understand;
//   * every field is re-validated on read, so a truncated, hand-edited or
//     otherwise damaged record degrades to "bundled baseline only" instead of
//     steering a lifecycle operation;
//   * writes are atomic (temp file, fsync, rename), so a crash mid-write cannot
//     leave a half-written record behind. A leftover `<record>.tmp` from such a
//     crash is ignored by readers and overwritten by the next write.
//
// Pure Node (no electron import) so it is unit-testable under node:test, like
// plugin-archive.ts and plugin-installer.ts.

import * as fs from 'fs';
import * as path from 'path';
import {
    type CatalogEntry,
    isArchiveDigest,
    isCommitSha,
    isInstallDirName,
    isPluginId,
    isPluginVersion,
    isRepositoryUrl,
} from './plugin-installer';

/** Bumped whenever the on-disk shape changes in a way readers must notice. */
export const SCHEMA_VERSION = 1;

/** File name inside the state directory, alongside the app's other state files. */
export const RECORD_FILE = 'installed-plugins.json';

/** The backend already refuses to load more than a few dozen plugins, so this
 *  is far above any real catalog; it only bounds what one file can hold. */
const MAX_RECORDS = 500;

/** Size gate for the same reason: a damaged or hostile file is refused before
 *  it is parsed, so a read stays bounded work in the main process. */
const MAX_RECORD_BYTES = 512 * 1024;

/** `catalogRevision` is an opaque identifier (the release record's
 *  `catalogSha256` today), so it is length-bounded rather than pattern-checked. */
const MAX_CATALOG_REVISION_LENGTH = 128;

/** Raised when a record cannot be written. Reads never throw. */
export class InstalledStateError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InstalledStateError';
    }
}

/** One installed optional plugin. Every field is required and validated. */
export interface InstalledPluginRecord {
    /** Catalog plugin id. */
    id: string;
    /** Directory name under the plugins dir holding this copy. */
    installDir: string;
    /** Plugin version, as declared by its plugin.json and the catalog. */
    version: string;
    /** HTTPS source repository the copy was installed from. */
    repository: string;
    /** Commit the source archive was resolved to (immutable pin). */
    commit: string;
    /** SHA-256 of the downloaded archive, as pinned by the catalog. */
    archiveSha256: string;
    /** ISO-8601 UTC install time, as written by `Date#toISOString`. */
    installedAt: string;
    /** Catalog revision the entry was resolved from (release-record digest). */
    catalogRevision: string;
}

/** Why an on-disk record could not be used. Its absence means "used as-is". */
export type InstalledStateIssue =
    /** No record yet: nothing was installed through the desktop, or it was removed. */
    | 'missing'
    /** The file exists but could not be read (permissions, wrong file type). */
    | 'unreadable'
    /** The file is not valid JSON, or not a record this version can use. */
    | 'corrupt'
    /** Written by a newer app version: readable in shape only, never rewritten. */
    | 'unsupported-schema';

export interface InstalledState {
    /** Records keyed by plugin id. Empty means "bundled baseline only". */
    plugins: Map<string, InstalledPluginRecord>;
    /** Schema version found on disk; 0 when there is no usable record. */
    schemaVersion: number;
    /** When the record was last written, or undefined when there is none. */
    updatedAt?: string;
    /** Set when the record on disk could not be used; `plugins` is then empty. */
    issue?: InstalledStateIssue;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Absolute path of the record. `stateDir` is app.getPath('userData'). */
export function installedStatePath(stateDir: string): string {
    // stateDir is a resolved app-state directory, never caller input
    return path.join(stateDir, RECORD_FILE);
}

/**
 * `Date#parse` also accepts loose forms such as `1` or `Mon Sep 01 2026` that
 * this app never writes, so require the canonical round-trip instead.
 */
function isCanonicalTimestamp(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isValidRecord(record: unknown): record is InstalledPluginRecord {
    if (!isObject(record)) return false;
    return isPluginId(record.id)
        && isInstallDirName(record.installDir)
        && isPluginVersion(record.version)
        && isRepositoryUrl(record.repository)
        && isCommitSha(record.commit)
        && isArchiveDigest(record.archiveSha256)
        && isCanonicalTimestamp(record.installedAt)
        && typeof record.catalogRevision === 'string'
        && record.catalogRevision.length > 0
        && record.catalogRevision.length <= MAX_CATALOG_REVISION_LENGTH;
}

function emptyState(issue: InstalledStateIssue, schemaVersion = 0): InstalledState {
    return { plugins: new Map(), schemaVersion, issue };
}

/**
 * Read the installed-state record. Never throws: a missing, unreadable,
 * truncated or foreign-schema record yields an empty map plus an `issue`, which
 * callers read as "bundled baseline only" rather than as a failure. Individual
 * records that do not validate are dropped so one damaged entry cannot hide
 * the rest.
 */
export function readInstalledState(stateDir: string): InstalledState {
    const file = installedStatePath(stateDir);
    let size: number;
    try {
        size = fs.statSync(file).size;
    } catch (e: any) {
        // Nothing installed through the desktop yet is the expected state, not
        // an anomaly, so it is not logged.
        if (e?.code === 'ENOENT') return emptyState('missing');
        console.warn(`[plugin-installed-state] record could not be read at ${file}: ${String(e)}`);
        return emptyState('unreadable');
    }
    if (size > MAX_RECORD_BYTES) {
        console.warn(`[plugin-installed-state] record is ${size} bytes, past the ${MAX_RECORD_BYTES} limit; ignoring it: ${file}`);
        return emptyState('corrupt');
    }

    let raw: string;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
        console.warn(`[plugin-installed-state] record could not be read at ${file}: ${String(e)}`);
        return emptyState('unreadable');
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        console.warn(`[plugin-installed-state] record is not valid JSON; ignoring it: ${file}`);
        return emptyState('corrupt');
    }
    if (!isObject(parsed) || !Number.isInteger(parsed.schemaVersion)) {
        console.warn(`[plugin-installed-state] record has no usable schemaVersion; ignoring it: ${file}`);
        return emptyState('corrupt');
    }
    const schemaVersion = parsed.schemaVersion as number;
    if (schemaVersion > SCHEMA_VERSION) {
        console.warn(`[plugin-installed-state] record is schema v${schemaVersion} (this app writes v${SCHEMA_VERSION}); leaving it alone`);
        return emptyState('unsupported-schema', schemaVersion);
    }
    if (schemaVersion < SCHEMA_VERSION) {
        // No schema older than v1 has ever been written, so this can only be a
        // damaged or hand-made file. Later versions add a migration here.
        console.warn(`[plugin-installed-state] record is schema v${schemaVersion}, older than v${SCHEMA_VERSION}; ignoring it: ${file}`);
        return emptyState('corrupt');
    }
    if (!isObject(parsed.plugins)) {
        console.warn(`[plugin-installed-state] record has no plugin table; ignoring it: ${file}`);
        return emptyState('corrupt');
    }

    const plugins = new Map<string, InstalledPluginRecord>();
    for (const [id, value] of Object.entries(parsed.plugins)) {
        if (!isValidRecord(value) || value.id !== id) {
            console.warn(`[plugin-installed-state] dropping invalid record for plugin ${id}`);
            continue;
        }
        plugins.set(id, value);
    }
    return isCanonicalTimestamp(parsed.updatedAt)
        ? { plugins, schemaVersion, updatedAt: parsed.updatedAt }
        : { plugins, schemaVersion };
}

/**
 * Persist `records` as the whole installed state, replacing whatever was there.
 *
 * Atomic: the body is written to `<record>.tmp`, flushed, and renamed over the
 * record, so a reader either sees the previous record or the new one — never a
 * partial file. The containing directory is deliberately not fsynced: Windows
 * cannot open a directory for that, and an unflushed directory entry can lose the
 * rename to a power failure, which leaves the record at its previous state or
 * missing — both of which read as "bundled baseline only" rather than as a wrong
 * record. Throws (rather than silently dropping provenance) if the write cannot be
 * completed, or if the record on disk is newer than this app understands and would
 * therefore be lost.
 *
 * Callers must serialize their writes: the record is re-read to check its schema
 * and then replaced wholesale, and the temp file has a fixed name, so two
 * concurrent writers can drop each other's entries.
 */
export function writeInstalledState(
    stateDir: string,
    records: Iterable<InstalledPluginRecord>,
    now: string,
): void {
    if (readInstalledState(stateDir).issue === 'unsupported-schema') {
        throw new InstalledStateError(
            'The installed-state record was written by a newer version of the app and will not be overwritten.',
        );
    }

    const plugins: Record<string, InstalledPluginRecord> = {};
    // One plugin per id and one directory per plugin: uninstall and rollback
    // address a copy by installDir, so an id/directory collision would make them
    // ambiguous. loadCatalog drops such duplicates; a write must refuse them.
    const dirs = new Set<string>();
    for (const record of records) {
        if (!isValidRecord(record)) {
            console.error('[plugin-installed-state] refusing to record an invalid entry', record);
            throw new InstalledStateError('The installed-state record was not written: an entry is invalid.');
        }
        const dir = record.installDir.toLowerCase();
        if (Object.hasOwn(plugins, record.id) || dirs.has(dir)) {
            console.error('[plugin-installed-state] refusing duplicate entry', record.id, record.installDir);
            throw new InstalledStateError('The installed-state record was not written: two plugins claim the same id or directory.');
        }
        dirs.add(dir);
        plugins[record.id] = record;
    }
    if (Object.keys(plugins).length > MAX_RECORDS) {
        throw new InstalledStateError('The installed-state record was not written: too many plugins are recorded.');
    }

    const body = `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, updatedAt: now, plugins }, null, 2)}\n`;
    const file = installedStatePath(stateDir);
    const tmp = `${file}.tmp`;
    try {
        fs.mkdirSync(stateDir, { recursive: true });
        // Create the temp file exclusively, so a symlink planted on that path is
        // refused rather than written through. Any leftover from an earlier crash
        // is cleared first: it is this module's own scratch file.
        fs.rmSync(tmp, { force: true });
        const fd = fs.openSync(tmp, 'wx');
        try {
            fs.writeFileSync(fd, body);
            // The rename is atomic, but without this flush a power loss can leave
            // the renamed file empty.
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        // Renames over a symlink at the record path instead of following it, so
        // nothing on that path can redirect this write.
        fs.renameSync(tmp, file);
    } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean up */ }
        console.error('[plugin-installed-state] could not write the record', e);
        throw new InstalledStateError('The installed-state record could not be written.');
    }
}

/**
 * Build the record for a freshly installed catalog entry. The catalog already
 * validated the entry and the download was pinned to it, so every field the
 * lifecycle needs comes straight from the entry.
 */
export function installedRecordFor(entry: CatalogEntry, catalogRevision: string, installedAt: string): InstalledPluginRecord {
    const record: InstalledPluginRecord = {
        id: entry.id,
        installDir: entry.installDir,
        version: entry.version,
        repository: entry.repository,
        commit: entry.commit,
        archiveSha256: entry.archiveSha256,
        installedAt,
        catalogRevision,
    };
    if (!isValidRecord(record)) {
        throw new InstalledStateError(`${entry.name} cannot be recorded as installed.`);
    }
    return record;
}