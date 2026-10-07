// Compatibility of a catalog entry against the build showing it (issue #16,
// catalog UI 2/5): does this plugin fit this fee[dB]ack, and when it does not,
// why — in words the catalog card can put in front of the user.
//
// The declaration is the entry's `compatibility` object (see
// resources/plugin-catalog.schema.json): a required minimum core and plugin-API
// version, plus an optional maximum of each. The core version this build runs
// is the desktop's own version — the desktop ships the core, so app.getVersion()
// is the core build the catalog is judged against, and the shipped entries'
// `minCoreVersion: "0.3.0"` is exactly what package.json declares.
//
// Pure (no electron, no filesystem, no network) so the rule is unit-tested on
// its own, and so the screen and any future install gate ask the same single
// question of the same function: two copies of this switch would drift into the
// app offering an install the installer refuses, or the reverse.

/** The build a catalog entry is being judged against. */
export interface BuildVersions {
    /** The fee[dB]ack core build this desktop release ships (app.getVersion()). */
    coreVersion: string;
    /** The plugin API generation this build's core implements. */
    pluginApiVersion: string;
}

/** Whether one entry fits one build, and how to say so on screen. */
export interface CompatibilityView {
    ok: boolean;
    /**
     * The declared requirements as a display phrase — "fee[dB]ack core 0.3.0 or
     * newer, plugin API 1 or newer" — with no leading verb, so the card can
     * prefix it ("Requires …") however it lays the line out. "" when the entry
     * declares no bounds. Owned here so the card and the reason below cannot
     * phrase the same requirement two ways.
     */
    requirements: string;
    /** Why the entry does not fit this build; null when it does. */
    reason: string | null;
}

/**
 * The plugin API generation this build implements. The backend that serves the
 * plugin API is not part of this repository, so nothing here can probe it at
 * runtime: the desktop declares the API level it ships with, next to the core
 * version it reports. Bump this when the plugin contract the bundled core
 * implements changes.
 */
export const PLUGIN_API_VERSION = '1';

/**
 * Order two dotted version strings for the catalog's compatibility bounds.
 *
 * The schema requires the bounds to be non-empty strings and nothing more, and
 * the plugin-API bound is a bare generation ("1"), so this cannot assume semver
 * input the way plugin-lifecycle's compareVersions does — that function answers
 * 0 for anything it cannot parse, which would silently swallow a real mismatch
 * like "1" against "2" and report an incompatible plugin as fine.
 *
 * Segments compare numerically when both are numeric and as text otherwise,
 * with a missing segment counting as 0, so "0.3.0" is below "0.10.0" and "1"
 * equals "1.0". One limitation, taken on purpose: a prerelease suffix inside a
 * *bound* ("1.0.0-alpha") is ordered as text rather than the way semver orders
 * it. No shipped entry caps a maximum at a prerelease; do not write one.
 */
export function compareBound(a: string, b: string): number {
    const left = String(a).split('.');
    const right = String(b).split('.');
    const length = Math.max(left.length, right.length);
    for (let i = 0; i < length; i++) {
        const l = left[i] ?? '0';
        const r = right[i] ?? '0';
        if (l === r) continue;
        const ln = /^[0-9]+$/.test(l);
        const rn = /^[0-9]+$/.test(r);
        if (ln && rn) {
            // Compare as numbers once the string equality above has failed:
            // "03" and "3" are different strings for the same value, and
            // falling through to the text comparison below would report each
            // as greater than the other, so no bound could ever match.
            const difference = Number(l) - Number(r);
            if (difference !== 0) return difference < 0 ? -1 : 1;
            continue;
        }
        return l < r ? -1 : 1;
    }
    return 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bound(value: unknown): string | null {
    return typeof value === 'string' && value ? value : null;
}

/** "fee[dB]ack core 0.3.0 or newer", "plugin API 1 to 2", or "" for no bound. */
function boundPhrase(label: string, min: string | null, max: string | null): string {
    if (min && max) return `${label} ${min} to ${max}`;
    if (min) return `${label} ${min} or newer`;
    if (max) return `${label} ${max} or earlier`;
    return '';
}

/**
 * Judge one catalog entry against one build.
 *
 * A missing or damaged declaration is *not* an incompatibility: refusing here
 * would invent a requirement the catalog never stated, and keeping the card
 * free of a verdict it has no evidence for is the honest rendering. The
 * release-time validator (scripts/validate-plugin-catalog.js) is what keeps
 * declarations present and well-formed; this is the runtime read of one.
 */
export function compatibilityFor(
    entry: { name?: unknown; compatibility?: unknown },
    build: BuildVersions,
): CompatibilityView {
    const declaration = isObject(entry.compatibility) ? entry.compatibility : {};
    const minCore = bound(declaration.minCoreVersion);
    const maxCore = bound(declaration.maxCoreVersion);
    const minApi = bound(declaration.minPluginApiVersion);
    const maxApi = bound(declaration.maxPluginApiVersion);

    const requirements = [
        boundPhrase('fee[dB]ack core', minCore, maxCore),
        boundPhrase('plugin API', minApi, maxApi),
    ].filter(Boolean).join(', ');

    const name = typeof entry.name === 'string' && entry.name ? entry.name : 'This plugin';
    const { coreVersion, pluginApiVersion } = build;
    let reason: string | null = null;
    if (minCore && compareBound(coreVersion, minCore) < 0) {
        reason = `${name} needs fee[dB]ack core ${minCore} or newer; this build ships ${coreVersion}.`;
    } else if (maxCore && compareBound(coreVersion, maxCore) > 0) {
        reason = `${name} supports fee[dB]ack core up to ${maxCore}; this build ships ${coreVersion}.`;
    } else if (minApi && compareBound(pluginApiVersion, minApi) < 0) {
        reason = `${name} needs plugin API ${minApi} or newer; this build provides ${pluginApiVersion}.`;
    } else if (maxApi && compareBound(pluginApiVersion, maxApi) > 0) {
        reason = `${name} supports plugin API up to ${maxApi}; this build provides ${pluginApiVersion}.`;
    }
    return { ok: reason === null, requirements, reason };
}
