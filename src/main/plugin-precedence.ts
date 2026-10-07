// Bundled baseline vs writable override precedence (issue #22, lifecycle 3/6 of
// #6): which on-disk copy of a plugin id the backend loads, plus the directory
// scan that classifies copies the way the backend does. The catalog projection
// reports that one answer as the row's `activeSource`.
//
// A plugin id can exist twice: as a packaged copy inside the core plugins dir
// (shipped with the app, replaced only by a desktop update) and as a writable
// copy inside the user plugins dir (what this app installs and uninstalls). The
// backend loads at most one copy per id. The rule mirrors core's own
// resolution — see `_is_bundled` in core and "User copies vs. bundled plugins"
// in docs/PLUGIN_CATALOG.md:
//
//   * the backend scans the user plugins dir before the packaged core plugins
//     dir, so a writable copy shadows a packaged one with the same id — unless
//   * the packaged copy is a *bundled baseline*: a directory named after its id
//     whose manifest says `"bundled": true`. That copy always wins.
//
// A bundled baseline also refuses overwrites at install time
// (plugin-installer.ts protectedIds), so the both-present state for a baseline
// can only be reached by hand-placing a copy; it still resolves
// deterministically, with the baseline winning and the override shadowed.
//
// Free of any electron import (like plugin-archive.ts) so the whole decision is
// unit-testable under node:test, and the scan sorts readdir results so two
// copies claiming one id resolve the same way on every platform.

import * as fs from 'fs';
import * as path from 'path';

/**
 * Which on-disk copy of a plugin id the backend loads:
 * - `bundled` — the packaged core copy: a bundled baseline that beats a
 *   hand-placed writable copy, or a packaged copy with no writable copy beneath
 *   it at all.
 * - `writable-override` — a writable copy shadows a packaged copy that did not
 *   claim `bundled: true` (the backend scans the user plugins dir first).
 * - `installed` — a writable copy loads and no packaged copy of the id exists.
 * - `none` — no copy of the id is on disk.
 */
export type ActiveSource = 'bundled' | 'writable-override' | 'installed' | 'none';

/** One on-disk copy of a plugin id, as the scan saw it. */
export interface PluginCopy {
    /** The directory name the copy lives in. */
    dir: string;
    /** The copy's version string (`''` when its manifest has none). */
    version: string;
    /**
     * True only for a bundled baseline: a copy whose directory is named after
     * its id and whose manifest says `"bundled": true`. The scan does not know
     * which root it is under; the callers that load the *core* plugins dir are
     * the ones that treat such a copy as a protected baseline.
     */
    bundled: boolean;
}

/**
 * Which copy of an id is active, given the packaged core copy (`baseline`) and
 * the writable copy (`override`), either of which may be absent. The answer is
 * always exactly one source.
 */
export function activeSourceFor(baseline: PluginCopy | null, override: PluginCopy | null): ActiveSource {
    if (!baseline) return override ? 'installed' : 'none';
    if (baseline.bundled) return 'bundled';
    return override ? 'writable-override' : 'bundled';
}

function readManifest(dir: string): Record<string, unknown> | null {
    try {
        // dir is a scanned plugin directory from the app's own directories
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf-8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Scan a plugins directory and return the copy of each manifest id it holds.
 *
 * readdir order is not defined, so entries are sorted first: when two
 * directories within one root claim the same id, the first in sorted order
 * keeps the claim unless the other is a bundled baseline, which always outranks
 * a sibling. A missing or unreadable root yields an empty map.
 */
export function scanPluginCopies(dir: string): Map<string, PluginCopy> {
    const copies = new Map<string, PluginCopy>();
    let entries: string[] = [];
    try {
        entries = fs.readdirSync(dir);
    } catch {
        return copies;
    }
    entries.sort();
    for (const name of entries) {
        if (name.startsWith('.')) continue;
        const manifest = readManifest(path.join(dir, name));
        if (!manifest) continue;
        const id = manifest.id;
        if (typeof id !== 'string') continue;
        const copy: PluginCopy = {
            dir: name,
            version: String(manifest.version ?? ''),
            bundled: manifest.bundled === true && name === id,
        };
        const existing = copies.get(id);
        if (existing && (existing.bundled || !copy.bundled)) continue;
        copies.set(id, copy);
    }
    return copies;
}