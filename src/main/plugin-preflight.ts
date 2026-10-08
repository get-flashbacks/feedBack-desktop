// Desktop-update plugin compatibility preflight (lifecycle 5/6 of #6, issue
// #24): before a desktop update is applied, decide whether each installed
// optional plugin is expected to run on the *target* build, so a plugin the
// next release cannot load is disabled up front instead of being silently
// replaced by arbitrary upstream code — and surface the same verdicts for
// deprecated / withdrawn / security-blocked catalog entries.
//
// This file owns only the *pure rule*: it takes the catalog, the installed
// records and the target build and answers "what must happen to each plugin for
// this update to be safe?". plugin-manager.ts asks the same function the screen
// does, so the message the user reads and the gate the apply path honours
// cannot drift apart. It re-uses plugin-compat's single compatibility question
// (compatibilityFor) rather than restating version bounds here.
//
// No electron, no filesystem, no network — unit-testable on its own.

import { compatibilityFor, type CompatibilityView, type BuildVersions } from './plugin-compat';
import {
    CATALOG_STATUSES,
    CatalogEntry,
    CatalogSource,
    repositoryParts,
} from './plugin-installer';
import type { InstalledPluginRecord } from './plugin-installed-state';
import type { CatalogEntryStatus } from './plugin-installer';

export type { CatalogEntryStatus };

/** Read the optional `status` field an entry declares, defaulting to "active". */
export function entryStatus(entry: CatalogEntry): CatalogEntryStatus {
    const raw = entry.status;
    return typeof raw === 'string' && CATALOG_STATUSES.has(raw)
        ? (raw as CatalogEntryStatus)
        : 'active';
}

/**
 * Hard blocks — withdrawn (gone) and security-blocked (dangerous on this build)
 * — cannot be re-enabled on the build that carries them. A deprecated entry is
 * advisory: it still runs and can still be enabled, but the caller is told to
 * warn the user that it is on its way out.
 */
export function isEntryBlocked(entry: CatalogEntry): boolean {
    const status = entryStatus(entry);
    return status === 'withdrawn' || status === 'security-blocked';
}

/**
 * Plain-English reason the screen shows for a blocked entry, or null when the
 * entry is not blocked. Kept here so the card and the enable-gate say the same
 * thing about why the plugin cannot be re-enabled.
 */
export function blockedReason(entry: CatalogEntry): string | null {
    switch (entryStatus(entry)) {
        case 'withdrawn':
            return `${entry.name} has been withdrawn and has been disabled on this version of fee[dB]ack.`;
        case 'security-blocked':
            return `${entry.name} is security-blocked on this version of fee[dB]ack and has been disabled.`;
        default:
            return null;
    }
}

/**
 * Whether enabling the plugin is permitted on the running build. Hard-blocked
 * entries cannot be re-enabled without an explicit override path — the user must
 * move to a build that no longer carries the block (i.e. defer the desktop
 * update, or apply one where the entry is no longer blocked). Deprecated entries
 * can be enabled; they only warn. Returns the same answer the enable-gate in
 * plugin-manager.ts enforces, so the row and the operation agree.
 */
export function canReenablePlugin(entry: CatalogEntry): boolean {
    return !isEntryBlocked(entry);
}

export type PreflightAction = 'keep' | 'disable';

export interface PreflightVerdict {
    id: string;
    name: string;
    /** Version recorded on disk, the copy the preflight reasons about. */
    installedVersion: string;
    source: CatalogSource;
    /** Catalog lifecycle status, independent of build. */
    status: CatalogEntryStatus;
    /** What this build's plugin API says the entry needs, and whether the target meets it. */
    targetCompat: CompatibilityView;
    /** What the update apply path should do with the copy. */
    action: PreflightAction;
    /** Why, in words the screen can put in front of the user. "" when nothing applies. */
    explanation: string;
}

export interface PreflightReport {
    verdicts: PreflightVerdict[];
    /** True when at least one plugin must be disabled (or held) before the update can proceed safely. */
    needsAttention: boolean;
}

/**
 * Judge every installed optional plugin against the desktop update's target
 * build. Installed copies with no matching catalog entry — legacy installs the
 * catalog no longer carries — are left out of the report: they are not part of
 * this update's surface and must not be touched by it.
 */
export function preflightForUpdate(
    catalogEntries: CatalogEntry[],
    records: ReadonlyMap<string, InstalledPluginRecord>,
    target: BuildVersions,
): PreflightReport {
    const byId = new Map(catalogEntries.map(e => [e.id, e]));
    const verdicts: PreflightVerdict[] = [];
    let needsAttention = false;
    for (const [id, record] of records) {
        const entry = byId.get(id);
        if (!entry) continue;
        const status = entryStatus(entry);
        const compat = compatibilityFor(entry, target);
        let action: PreflightAction = 'keep';
        let explanation = '';
        if (isEntryBlocked(entry)) {
            action = 'disable';
            explanation = blockedReason(entry) ?? '';
        } else if (!compat.ok) {
            action = 'disable';
            explanation = compat.reason ?? `${entry.name} is not compatible with this release.`;
        } else if (status === 'deprecated') {
            action = 'keep';
            explanation = `${entry.name} is deprecated and will be removed in a future release.`;
        }
        if (action === 'disable') needsAttention = true;
        verdicts.push({
            id,
            name: entry.name,
            installedVersion: record.version,
            source: entry.source,
            status,
            targetCompat: compat,
            action,
            explanation,
        });
    }
    return { verdicts, needsAttention };
}

/**
 * GitHub owner the archive for an entry would be downloaded from, read straight
 * from its `repository` URL (the archive is always `<repository>/zip/<commit>`).
 */
export function archiveOriginOwner(entry: CatalogEntry): string | null {
    const parts = repositoryParts(entry.repository);
    return parts ? parts.owner : null;
}

/**
 * Whether an entry's archive provenance matches its declared trust class — i.e.
 * the file the installer would download is fetched from the owner the catalog
 * says the source is. The desktop never installs a `get-flashbacks` entry from
 * anywhere but the `get-flashbacks` owner: there is no upstream fork of a
 * get-flashbacks fork to fall back to, so a get-flashbacks entry that names
 * another owner is a corrupted catalog entry the install gate rejects before a
 * byte is downloaded. `upstream-official` is the lone exception that may name a
 * different owner (`got-feedback`, the upstream project's official home); the
 * desktop installs a `get-flashbacks` source only from a `get-flashbacks` fork,
 * and only falls back to upstream when no fork exists.
 */
export function isTrustedCatalogSource(entry: CatalogEntry): boolean {
    const parts = repositoryParts(entry.repository);
    if (!parts) return false;
    const owner = parts.owner.toLowerCase();
    if (entry.source === 'get-flashbacks') return owner === 'get-flashbacks';
    if (entry.source === 'upstream-official') return owner === 'got-feedback';
    // reviewed-community: the lock pins commit + sha256, so origin is anchored to
    // a record rather than to an owner name.
    return true;
}
