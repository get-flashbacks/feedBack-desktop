// Plugin lifecycle decisions (issue #21, lifecycle 2/6 of #6): what an update,
// a downgrade, a pin, a disable and an uninstall may do to one installed plugin.
//
// Everything here is pure: it takes the installed-state record and a catalog
// entry and answers a question. No electron, no filesystem, no network — so the
// rules that actually protect the user's install (a pinned plugin is not updated,
// a disabled one is not touched, a downgrade only ever reinstalls an archive the
// record already vouched for) are unit-testable on their own. plugin-manager.ts
// performs the disk work those answers authorize.
//
// The catalog carries one version per plugin, so an update is "install the
// catalog's version over the installed one" and a downgrade is "reinstall a pin
// from the record's own history" — never a URL the renderer supplies.

import * as path from 'path';
import { CatalogEntry, InstallError, isPluginId, isPluginVersion, validateCatalogEntry } from './plugin-installer';
import { InstalledPluginRecord, MAX_HISTORY, RecordedPin, pinFor } from './plugin-installed-state';

/** Why an update is or is not offered for one installed plugin. */
export type UpdateStatus =
    /** Not installed through the desktop (or the catalog has no entry for it). */
    | 'not-installed'
    /** The catalog's pin is what is installed. */
    | 'current'
    /** Same version, different archive: the release was re-cut under one version. */
    | 'republished'
    /** A newer version is pinned in the catalog. */
    | 'available'
    /** The user pinned this version, so updates are held. */
    | 'pinned'
    /** The plugin is disabled; re-enable it before updating. */
    | 'disabled'
    /** The catalog is behind what is installed, which is a downgrade, not an update. */
    | 'ahead';

/** Whether the catalog offers something to install over the installed copy. */
export function isUpdateAvailable(status: UpdateStatus): boolean {
    return status === 'available' || status === 'republished';
}

/**
 * Compare two plugin versions. Accepts only the shape the catalog accepts
 * (`X.Y.Z` or `X.Y.Z-prerelease`), so the ordering never has to cope with
 * something that is not a version: an unparseable value sorts below everything,
 * which reads as "not newer" and so never authorizes an install.
 *
 * Prereleases sort below the release they lead to, and their identifiers are
 * compared the way semver does: numerically where both are numeric, otherwise
 * ASCII, with a numeric identifier below an alphanumeric one.
 */
export function compareVersions(a: unknown, b: unknown): number {
    const left = parseVersion(a);
    const right = parseVersion(b);
    if (!left || !right) return 0;
    for (let i = 0; i < 3; i++) {
        if (left.release[i] !== right.release[i]) return left.release[i] < right.release[i] ? -1 : 1;
    }
    const lp = left.pre;
    const rp = right.pre;
    if (!lp.length && !rp.length) return 0;
    if (!lp.length) return 1;
    if (!rp.length) return -1;
    for (let i = 0; i < Math.max(lp.length, rp.length); i++) {
        const x = lp[i];
        const y = rp[i];
        // A shorter prerelease is the lower one: 1.0.0-alpha < 1.0.0-alpha.1.
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        if (x === y) continue;
        const xn = /^[0-9]+$/.test(x);
        const yn = /^[0-9]+$/.test(y);
        if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
        if (xn) return -1;
        if (yn) return 1;
        return x < y ? -1 : 1;
    }
    return 0;
}

function parseVersion(value: unknown): { release: [number, number, number]; pre: string[] } | null {
    if (typeof value !== 'string' || !isPluginVersion(value)) return null;
    const [core, pre = ''] = value.split('-', 2);
    const release = core.split('.').map(part => Number.parseInt(part, 10));
    if (release.length !== 3 || release.some(part => !Number.isInteger(part))) return null;
    return { release: release as [number, number, number], pre: pre ? pre.split('.') : [] };
}

/**
 * What the catalog's entry means for one installed copy. `entry` is the
 * catalog's current pin for this plugin id, `record` what is on disk.
 */
export function updateStatusFor(
    record: InstalledPluginRecord | null,
    entry: CatalogEntry | undefined,
): UpdateStatus {
    if (!record || !entry) return 'not-installed';
    if (record.enabled === false) return 'disabled';
    if (record.pinned) return 'pinned';
    if (record.version === entry.version) {
        return record.archiveSha256 === entry.archiveSha256 && record.commit === entry.commit
            ? 'current'
            : 'republished';
    }
    return compareVersions(entry.version, record.version) > 0 ? 'available' : 'ahead';
}

/** The entry an update would install, or null when nothing may be installed. */
export function resolveUpdate(
    record: InstalledPluginRecord | null,
    entry: CatalogEntry | undefined,
): CatalogEntry | null {
    return isUpdateAvailable(updateStatusFor(record, entry)) && entry ? entry : null;
}

/**
 * Why the catalog's version may not be installed over the copy that is installed
 * now, or null when it may. One rule for every path that performs that install —
 * the per-plugin Update button and the catalog list's batch selection alike — so a
 * pinned, disabled or ahead copy cannot be swapped by selecting it in the list
 * instead. Going back is a downgrade, which only ever reinstalls a pin from the
 * record's own history.
 */
export function installRefusal(entry: CatalogEntry, record: InstalledPluginRecord): string | null {
    switch (updateStatusFor(record, entry)) {
        case 'current':
            return `${entry.name} is already up to date.`;
        case 'pinned':
            return `${entry.name} is pinned at ${record.version}. Unpin it to install ${entry.version}.`;
        case 'disabled':
            return `${entry.name} is disabled. Enable it to install ${entry.version}.`;
        case 'ahead':
            return `The catalog's ${entry.name} (${entry.version}) is older than what is installed (${record.version}). `
                + 'Use "Downgrade" to go back.';
        default:
            return null;
    }
}

/** One request the batch will not make, shaped like a batch result. */
export interface RefusedInstall {
    id: string;
    name: string;
    success: false;
    message: string;
    /** Set only when the failure is a connectivity problem (see BatchItemResult). */
    networkRequired?: boolean;
}

/**
 * Split a requested selection into what a batch may install and what each
 * plugin's own recorded state forbids. The refusals come back as batch-shaped
 * results, so the screen reports them per plugin instead of losing them, and
 * every refusal is the same one the per-plugin operation would give.
 */
export function splitLifecycleRequests(
    ids: Iterable<string>,
    records: ReadonlyMap<string, InstalledPluginRecord>,
    entries: Iterable<CatalogEntry>,
): { allowed: string[]; refused: RefusedInstall[] } {
    const byId = new Map<string, CatalogEntry>();
    for (const entry of entries) byId.set(entry.id, entry);
    const allowed: string[] = [];
    const refused: RefusedInstall[] = [];
    for (const id of ids) {
        const entry = byId.get(id);
        // No record means the copy was not installed here, so there is no installed
        // version for this install to go over.
        const record = entry ? records.get(entry.id) : undefined;
        const message = entry && record ? installRefusal(entry, record) : null;
        if (message) refused.push({ id, name: entry?.name ?? id, success: false, message });
        else allowed.push(id);
    }
    return { allowed, refused };
}

/**
 * Ids of installed plugins an update check offers to update. Pinned and disabled
 * plugins are not in it: a pin is the user saying "leave this version alone",
 * and a disabled plugin is not loaded, so neither has an update to offer.
 */
export function updateCandidates(
    records: Map<string, InstalledPluginRecord>,
    entries: Iterable<CatalogEntry>,
): string[] {
    const ids: string[] = [];
    for (const entry of entries) {
        const record = records.get(entry.id);
        if (record && isUpdateAvailable(updateStatusFor(record, entry))) ids.push(entry.id);
    }
    return ids;
}

/**
 * The pins a downgrade could reinstall, newest first, without the version that is
 * installed now and without anything the record could not vouch for.
 */
export function downgradeCandidates(record: InstalledPluginRecord | null): RecordedPin[] {
    if (!record?.previousVersions?.length) return [];
    return record.previousVersions.filter(pin => pin.version !== record.version);
}

/**
 * The catalog entry a recorded pin is reinstalled as. The pin is the same
 * immutable archive the catalog pinned when that version was current, so a
 * downgrade re-verifies the download against the digest that was recorded for it
 * rather than against today's catalog.
 */
export function entryForPin(record: InstalledPluginRecord, pin: RecordedPin, name: string): CatalogEntry {
    const entry: CatalogEntry = {
        id: record.id,
        installDir: record.installDir,
        name,
        repository: pin.repository,
        version: pin.version,
        commit: pin.commit,
        archiveSha256: pin.archiveSha256,
        source: pin.source,
        dependencies: [],
        conflicts: [],
        size: { downloadBytes: pin.downloadBytes, installedBytes: pin.installedBytes },
    };
    // A pin is trusted because it was validated when it was written, not
    // because it validates now: refuse rather than install if a damaged record
    // produced something the installer's own gate would reject.
    if (!validateCatalogEntry(entry)) throw new InstallError('That recorded version cannot be reinstalled.');
    return entry;
}

/**
 * The record to write after `entry` has been installed over `previous` (null for
 * a first install).
 *
 * A version that got displaced joins the history, newest first, capped at
 * MAX_HISTORY so the record cannot grow without bound. The pin is dropped: it
 * held the version that was installed before, which is no longer the version on
 * disk, so keeping it would silently freeze the copy the user just moved to.
 * `enabled` carries over so updating a disabled plugin (a reinstall in place)
 * never quietly re-enables it.
 */
export function nextRecordAfterInstall(
    previous: InstalledPluginRecord | null,
    entry: CatalogEntry,
    catalogRevision: string,
    installedAt: string,
): InstalledPluginRecord {
    const history = [...(previous?.previousVersions ?? [])];
    if (previous) {
        const displaced = pinFor(previous);
        if (displaced) history.unshift(displaced);
    }
    return {
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
        enabled: previous ? previous.enabled : true,
        pinned: false,
        ...(history.length ? { previousVersions: history.slice(0, MAX_HISTORY) } : {}),
    };
}

/**
 * The record after a manual rollback restored the backup: the record is rebuilt
 * from the history pin whose version matches the copy actually on disk. That
 * match cannot be `previousVersions[0]` alone — a second install over an
 * unconfirmed copy keeps the OLD backup and discards the intermediate copy, so
 * the first history entry names a version that is nowhere on disk. The caller
 * reads the restored version from the restored manifest (see
 * `installedVersionOnDisk`) and passes it as `onDiskVersion`.
 *
 * Only pins older than the restored version are kept: the version that was
 * rolled back from is never re-offered as a downgrade, because its activation
 * was never confirmed. The pin is cleared — it was a statement about the
 * version that was installed, not the one restored — and `enabled` carries over.
 *
 * Returns the record unchanged when the disk already agrees with it, and null
 * when no history pin matches the restored version, so the caller can drop the
 * record rather than let it claim a version that is not on disk.
 */
export function recordAfterRollback(
    record: InstalledPluginRecord,
    onDiskVersion: string,
    now: string,
): InstalledPluginRecord | null {
    if (onDiskVersion === record.version) return record;
    const restored = record.previousVersions?.find(pin => pin.version === onDiskVersion);
    if (!restored) return null;
    const history = (record.previousVersions ?? [])
        .filter(pin => pin.version !== restored.version && compareVersions(pin.version, restored.version) < 0)
        .slice(0, MAX_HISTORY);
    return {
        id: record.id,
        installDir: record.installDir,
        version: restored.version,
        repository: restored.repository,
        commit: restored.commit,
        archiveSha256: restored.archiveSha256,
        installedAt: now,
        catalogRevision: restored.catalogRevision,
        source: restored.source,
        downloadBytes: restored.downloadBytes,
        installedBytes: restored.installedBytes,
        enabled: record.enabled,
        pinned: false,
        ...(history.length ? { previousVersions: history } : {}),
    };
}

/**
 * The record after the user pinned (or unpinned) a version. Pinning is only ever
 * a statement about what is installed now, so it is refused for a plugin that is
 * not installed, and unpinning is always allowed.
 */
export function recordAfterPinChange(
    record: InstalledPluginRecord,
    pinned: boolean,
): InstalledPluginRecord {
    if (pinned && record.pinned) return record;
    return { ...record, pinned };
}

/**
 * Directories the app created for one plugin, which a confirmed "delete my data"
 * uninstall removes: its own `plugin_data` directory, any `plugin_data` entry
 * named after it (`<id>.json` and friends), and its `pip_packages` directory.
 *
 * Anything else under the config dir is left alone: the backend owns the rest of
 * its layout, so this is a fixed, conservative list rather than a guess at
 * everything a plugin might have written. `pluginDataEntries` are the names the
 * caller found under `plugin_data` (read here, matched here), which keeps this
 * function free of filesystem access.
 */
export function userDataPathsForPlugin(configDir: string, id: unknown, pluginDataEntries: Iterable<string> = []): string[] {
    if (typeof id !== 'string' || !isPluginId(id)) return [];
    const resolvedRoot = path.resolve(configDir);
    const contained = (root: string, name: string): string | null => {
        const target = path.resolve(root, name);
        const rel = path.relative(root, target);
        return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? target : null;
    };
    const paths: string[] = [];
    const dataDir = path.join(resolvedRoot, 'plugin_data');
    const own = contained(dataDir, id);
    if (own) paths.push(own);
    for (const name of pluginDataEntries) {
        // Only siblings of this plugin's own directory, and only literal names:
        // `metronome.config` is data, `../..` or an absolute name is not.
        if (typeof name !== 'string' || !name.startsWith(`${id}.`) || name !== path.basename(name)) continue;
        const sibling = contained(dataDir, name);
        if (sibling && !paths.includes(sibling)) paths.push(sibling);
    }
    const packages = contained(path.join(resolvedRoot, 'pip_packages'), id);
    if (packages) paths.push(packages);
    return paths;
}

/**
 * Everything the Plugin Manager shows for one plugin. Built from the record, the
 * catalog entry and what is on disk (`disabled` / `canRollback`), so the screen
 * and the operations it offers cannot disagree about what the state is.
 */
export interface LifecycleView {
    installed: boolean;
    /** Version recorded for the installed copy, or the catalog's when unknown. */
    installedVersion: string | null;
    enabled: boolean;
    pinned: boolean;
    updateStatus: UpdateStatus;
    updateAvailable: boolean;
    /** Versions a downgrade could reinstall, newest first. */
    downgradeVersions: string[];
    disabled: boolean;
    canRollback: boolean;
    /**
     * A plain-English recovery instruction for this copy, or "" when nothing
     * applies. Computed from `canRollback` and `downgradeVersions` so the screen
     * always agrees with the operations it actually offers (lifecycle 4/6): when
     * a backup is kept the user is told to "Restore previous", and when the
     * backup was already committed away they are told which earlier version
     * a "Downgrade" would reinstall. Not shown for disabled or uninstalled
     * copies — neither has an activation to recover.
     */
    recoveryInstructions: string;
}

export function lifecycleView(options: {
    entry: CatalogEntry;
    record: InstalledPluginRecord | null;
    disabled: boolean;
    canRollback: boolean;
}): LifecycleView {
    const { entry, record, disabled, canRollback } = options;
    // A copy that is parked on disk is disabled whatever the record says: the
    // directory is what the backend sees, so it is the fact the UI reports.
    const installed = record !== null || disabled;
    const status = updateStatusFor(record, entry);
    // A copy that is parked on disk reads as disabled even when no record
    // vouches for it: the directory is there, so "disabled" is the truth the
    // user can act on, where "not installed" would offer them an install.
    const effectiveStatus: UpdateStatus = installed && disabled ? 'disabled' : status;
    // Recovery instructions are only relevant while a copy is live: a disabled
    // copy is already parked (so there is no activation to recover), and an
    // uninstalled one has nothing on disk. A backup is the recovery path of
    // first resort; a committed-away backup leaves the recorded history as the
    // only way back, spoken of as the "Downgrade" buttons the view already lists.
    // The downgrade note fires only when the history holds a genuinely earlier
    // candidate: the history can also hold newer pins the user moved away from,
    // and the advice must not call those "earlier" or present a version whose
    // activation was never confirmed as the way back.
    let recoveryInstructions = '';
    if (installed && !disabled) {
        if (canRollback) {
            recoveryInstructions = `Use "Restore previous" to roll back ${entry.name} to the version installed before this one if this version does not work.`;
        } else if (downgradeCandidates(record).some(pin => compareVersions(pin.version, record?.version) < 0)) {
            recoveryInstructions = `Use "Downgrade" to return ${entry.name} to an earlier verified version if this version does not work.`;
        }
    }
    return {
        installed,
        installedVersion: record?.version ?? null,
        enabled: installed ? record?.enabled !== false && !disabled : true,
        pinned: record?.pinned === true,
        updateStatus: effectiveStatus,
        updateAvailable: isUpdateAvailable(effectiveStatus),
        downgradeVersions: downgradeCandidates(record).map(pin => pin.version),
        disabled,
        canRollback,
        recoveryInstructions,
    };
}

/** Coerce an unknown IPC argument to the plugin id it claims to be. */
export function pluginIdFrom(raw: unknown): string | null {
    return typeof raw === 'string' && isPluginId(raw) ? raw : null;
}

/** Coerce an unknown IPC argument to a version string the catalog accepts. */
export function versionFrom(raw: unknown): string | null {
    return typeof raw === 'string' && isPluginVersion(raw) ? raw : null;
}