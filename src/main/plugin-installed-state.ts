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
//     provenance it does not understand. An older supported schema is migrated
//     on read, so a record written by the previous release keeps working;
//   * every field is re-validated on read, so a truncated, hand-edited or
//     otherwise damaged record degrades to "bundled baseline only" instead of
//     steering a lifecycle operation;
//   * writes are atomic (temp file, fsync, rename) and serialized through
//     `updateInstalledState`, so a crash mid-write cannot leave a half-written
//     record behind and two lifecycle operations cannot drop each other's
//     entries. A leftover `<record>.tmp` from such a crash is ignored by readers
//     and overwritten by the next write.
//
// Pure Node (no electron import) so it is unit-testable under node:test, like
// plugin-archive.ts and plugin-installer.ts.

import * as fs from 'fs';
import * as path from 'path';
import {
    type CatalogEntry,
    isArchiveDigest,
    isCatalogSource,
    isCommitSha,
    isInstallDirName,
    isPluginId,
    isPluginVersion,
    isRepositoryUrl,
} from './plugin-installer';

/** Bumped whenever the on-disk shape changes in a way readers must notice.
 *  v2 added the lifecycle state of lifecycle 2/6: `enabled`, `pinned` and the
 *  `previousVersions` a downgrade reinstalls from. A v1 record is migrated on
 *  read rather than rejected — nothing in it means anything different, it only
 *  lacks the fields the lifecycle now writes. */
export const SCHEMA_VERSION = 2;

/** Oldest schema this build can still read. Anything below it is treated as
 *  damaged, exactly as an unknown future version is left alone. */
const MIN_SCHEMA_VERSION = 1;

/** File name inside the state directory, alongside the app's other state files. */
export const RECORD_FILE = 'installed-plugins.json';

/** The backend already refuses to load more than a few dozen plugins, so this
 *  is far above any real catalog; it only bounds what one file can hold. */
const MAX_RECORDS = 500;

/** Same reason: bounds the size of one plugin's downgrade history, and with it
 *  the whole file. A plugin that has been through this many versions is far
 *  past anything a real update stream produces. */
export const MAX_HISTORY = 10;

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

/**
 * One installed optional plugin. The provenance fields (id, installDir, version,
 * repository, commit, archiveSha256, installedAt, catalogRevision) are required
 * and validated; the lifecycle state below is required too, except for the
 * archive sizes and the history, which only exist once the lifecycle has run.
 */
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
    /**
     * The rest of what a recorded pin needs to reinstall this exact archive: the
     * catalog trust class, and the archive sizes the installer checks the
     * download against. A copy installed before schema v2 has none of them, and
     * is therefore reported as having no downgrade target until its next update
     * records them (see `pinFor`).
     */
    source?: CatalogEntry['source'];
    downloadBytes?: number;
    installedBytes?: number;
    /**
     * False when the user disabled the plugin without uninstalling it (2/6): the
     * copy is parked outside the backend's scan, and this is what says so. A
     * record without the field (v1) was written before disabling existed and
     * migrates to true.
     */
    enabled: boolean;
    /**
     * True when the user pinned the *recorded version* — update checks leave it
     * alone. Any operation that installs a different version clears the pin,
     * because the pin was a statement about the version that was installed then.
     */
    pinned: boolean;
    /**
     * Earlier pins this copy went through, newest first, for the downgrade
     * operation (2/6). Each entry carries everything the installer needs to
     * reinstall that exact archive, so a downgrade is verified against the same
     * digest the catalog pinned when that version was current. Omitted from the
     * file while empty, capped at MAX_HISTORY.
     */
    previousVersions?: RecordedPin[];
}

/**
 * One previously installed version of a plugin: enough to reinstall exactly
 * that archive, and to report which catalog revision it came from. The archive
 * size is part of the pin because the installer refuses a download whose length
 * or expanded size differs from the entry it is verifying.
 */
export interface RecordedPin {
    version: string;
    repository: string;
    commit: string;
    archiveSha256: string;
    downloadBytes: number;
    installedBytes: number;
    catalogRevision: string;
    /** Trust class of the catalog entry this version was installed from. */
    source: CatalogEntry['source'];
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

function isValidPin(pin: unknown): pin is RecordedPin {
    if (!isObject(pin)) return false;
    return isPluginVersion(pin.version)
        && isRepositoryUrl(pin.repository)
        && isCommitSha(pin.commit)
        && isArchiveDigest(pin.archiveSha256)
        && isPositiveByteCount(pin.downloadBytes)
        && isNonNegativeByteCount(pin.installedBytes)
        && isCatalogRevision(pin.catalogRevision)
        && isCatalogSource(pin.source);
}

function isCatalogRevision(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= MAX_CATALOG_REVISION_LENGTH;
}

function isNonNegativeByteCount(value: unknown): value is number {
    return Number.isInteger(value) && (value as number) >= 0;
}

function isPositiveByteCount(value: unknown): value is number {
    return Number.isInteger(value) && (value as number) > 0;
}

function isValidRecord(record: unknown): record is InstalledPluginRecord {
    if (!isObject(record)) return false;
    const hasSizes = record.downloadBytes !== undefined || record.installedBytes !== undefined;
    return isPluginId(record.id)
        && isInstallDirName(record.installDir)
        && isPluginVersion(record.version)
        && isRepositoryUrl(record.repository)
        && isCommitSha(record.commit)
        && isArchiveDigest(record.archiveSha256)
        && isCanonicalTimestamp(record.installedAt)
        && isCatalogRevision(record.catalogRevision)
        && (record.source === undefined || isCatalogSource(record.source))
        && (!hasSizes || (isPositiveByteCount(record.downloadBytes) && isNonNegativeByteCount(record.installedBytes)))
        && typeof record.enabled === 'boolean'
        && typeof record.pinned === 'boolean'
        && (record.previousVersions === undefined
            || (Array.isArray(record.previousVersions)
                && record.previousVersions.length <= MAX_HISTORY
                && record.previousVersions.every(isValidPin)));
}

/**
 * Bring a v1 record up to the current shape. Everything v1 recorded still means
 * the same thing; it just has no lifecycle state, and a plugin installed before
 * disabling existed was necessarily enabled and unpinned. It also has no archive
 * sizes, which leaves that one copy without a downgrade target until its next
 * update records them.
 */
function migrateRecord(record: Record<string, unknown>): InstalledPluginRecord {
    return {
        id: record.id as string,
        installDir: record.installDir as string,
        version: record.version as string,
        repository: record.repository as string,
        commit: record.commit as string,
        archiveSha256: record.archiveSha256 as string,
        installedAt: record.installedAt as string,
        catalogRevision: record.catalogRevision as string,
        enabled: true,
        pinned: false,
    };
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
    if (schemaVersion < MIN_SCHEMA_VERSION) {
        console.warn(`[plugin-installed-state] record is schema v${schemaVersion}, older than v${MIN_SCHEMA_VERSION}; ignoring it: ${file}`);
        return emptyState('corrupt');
    }
    if (!isObject(parsed.plugins)) {
        console.warn(`[plugin-installed-state] record has no plugin table; ignoring it: ${file}`);
        return emptyState('corrupt');
    }
    // An older supported schema is read through its migration rather than
    // rejected, so an install recorded by the previous release keeps its pin,
    // provenance and downgrade history. The file itself stays on the old schema
    // until the next write rewrites it.
    const migrate = schemaVersion < SCHEMA_VERSION
        ? migrateRecord
        : (r: Record<string, unknown>) => r as unknown as InstalledPluginRecord;

    const plugins = new Map<string, InstalledPluginRecord>();
    for (const [id, value] of Object.entries(parsed.plugins)) {
        if (!isObject(value)) {
            console.warn(`[plugin-installed-state] dropping invalid record for plugin ${id}`);
            continue;
        }
        const record = migrate(value);
        if (!isValidRecord(record) || record.id !== id) {
            console.warn(`[plugin-installed-state] dropping invalid record for plugin ${id}`);
            continue;
        }
        plugins.set(id, record);
    }
    return isCanonicalTimestamp(parsed.updatedAt)
        ? { plugins, schemaVersion: SCHEMA_VERSION, updatedAt: parsed.updatedAt }
        : { plugins, schemaVersion: SCHEMA_VERSION };
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
 * concurrent writers can drop each other's entries. `updateInstalledState` below
 * does the serializing; anything reaching this function directly must not race.
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
 * Read-modify-write the record, serialized.
 *
 * Every lifecycle operation changes one plugin's entry, and the file is replaced
 * wholesale, so two of them running at once (an update finishing while an
 * uninstall starts) would read the same snapshot and the second write would drop
 * the first one's entry. This is the single writer the lifecycle uses: each call
 * waits for the previous one, hands the mutator a private copy of the current
 * records, and writes the result. A mutator that throws leaves the file untouched.
 */
export async function updateInstalledState<T>(
    stateDir: string,
    mutate: (records: Map<string, InstalledPluginRecord>) => T,
    now: string,
): Promise<T> {
    const result = writeQueue.then(async () => {
        const records = new Map(readInstalledState(stateDir).plugins);
        const value = mutate(records);
        writeInstalledState(stateDir, records.values(), now);
        return value;
    });
    // The chain must survive a rejected mutation, or every later write would
    // queue behind a rejection that nothing handles.
    writeQueue = result.then(() => undefined, () => undefined);
    return result;
}

let writeQueue: Promise<void> = Promise.resolve();

/**
 * Build the record for a freshly installed catalog entry. The catalog already
 * validated the entry and the download was pinned to it, so every field the
 * lifecycle needs comes straight from the entry. A plugin that was disabled and
 * is being reinstalled or updated in place comes back disabled, so an operation
 * that swaps the source never quietly re-enables the plugin.
 */
export function installedRecordFor(
    entry: CatalogEntry,
    catalogRevision: string,
    installedAt: string,
    options: { enabled?: boolean; previousVersions?: RecordedPin[] } = {},
): InstalledPluginRecord {
    const record: InstalledPluginRecord = {
        id: entry.id,
        installDir: entry.installDir,
        version: entry.version,
        repository: entry.repository,
        commit: entry.commit,
        archiveSha256: entry.archiveSha256,
        installedAt,
        catalogRevision,
        source: entry.source,
        downloadBytes: entry.size.downloadBytes,
        installedBytes: entry.size.installedBytes,
        enabled: options.enabled !== false,
        // A pin is a statement about the version that is installed, so a fresh
        // record starts unpinned; a pin the user set is re-applied deliberately.
        pinned: false,
    };
    const history = options.previousVersions ?? [];
    if (history.length) record.previousVersions = history;
    if (!isValidRecord(record)) {
        throw new InstalledStateError(`${entry.name} cannot be recorded as installed.`);
    }
    return record;
}

/**
 * The pin of an installed copy, ready to be pushed onto `previousVersions` when a
 * later version displaces it. Null for a copy installed before schema v2: it
 * recorded neither the archive sizes nor the catalog trust class, and the
 * installer refuses a download whose length or expanded size it cannot check
 * against the entry it verifies. Such a copy can still be put back from the
 * backup slot, which holds the actual files.
 */
export function pinFor(record: InstalledPluginRecord): RecordedPin | null {
    if (record.source === undefined || record.downloadBytes === undefined || record.installedBytes === undefined) {
        return null;
    }
    return {
        version: record.version,
        repository: record.repository,
        commit: record.commit,
        archiveSha256: record.archiveSha256,
        downloadBytes: record.downloadBytes,
        installedBytes: record.installedBytes,
        catalogRevision: record.catalogRevision,
        source: record.source,
    };
}
