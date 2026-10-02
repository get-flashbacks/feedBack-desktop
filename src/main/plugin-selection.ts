// Guided plugin selection (issue #5).
//
// Turns the bundled catalog's own metadata into the questions the first-run
// wizard asks, the recommended selection for those answers, and the fully
// resolved install plan (dependency closure + conflict pruning).
//
// Everything here is data-driven from the catalog: the question list is
// derived from the instrument tags and categories the catalog actually
// contains, and a recommendation is a function of an entry's tags, category,
// selection tier and default flag — never of a hardcoded per-plugin UI rule.
// Adding a plugin to resources/plugin-catalog.json therefore changes what the
// wizard offers with no code change here.
//
// Pure Node (no electron import) so the whole decision layer is unit-testable;
// the window, IPC and download plumbing live in plugin-wizard.ts.

/** How prominently the catalog offers an entry during onboarding. */
export type SelectionTier = 'essential' | 'recommended' | 'optional' | 'hidden';

const TIERS: SelectionTier[] = ['essential', 'recommended', 'optional', 'hidden'];

/**
 * The catalog fields the selection layer needs, plus the live install state
 * merged in by plugin-manager's `plugins:catalog` projection.
 */
export interface SelectionEntry {
    id: string;
    name: string;
    description: string;
    version: string;
    category: string;
    instruments: string[];
    tier: SelectionTier;
    defaultSelected: boolean;
    dependencies: string[];
    conflicts: string[];
    downloadBytes: number;
    /** Version already on disk, or null when the plugin is not installed. */
    installedVersion: string | null;
    /** True when the app ships this plugin as a core bundled plugin. */
    bundled: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v !== '') : [];
}

function finiteNumber(value: unknown, fallback = 0): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Normalize a `plugins:catalog` row into a SelectionEntry. Unknown or damaged
 * rows are dropped rather than partially trusted — the wizard must never offer
 * an entry whose id or size it cannot vouch for.
 */
export function toSelectionEntry(raw: unknown): SelectionEntry | null {
    if (!isObject(raw)) return null;
    if (typeof raw.id !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(raw.id)) return null;
    const selection = isObject(raw.selection) ? raw.selection : {};
    const size = isObject(raw.size) ? raw.size : {};
    const tier = TIERS.includes(selection.tier as SelectionTier) ? (selection.tier as SelectionTier) : 'optional';
    return {
        id: raw.id,
        name: typeof raw.name === 'string' && raw.name ? raw.name : raw.id,
        description: typeof raw.description === 'string' ? raw.description : '',
        version: typeof raw.version === 'string' ? raw.version : '',
        category: typeof raw.category === 'string' ? raw.category : '',
        instruments: stringArray(raw.instruments),
        tier,
        defaultSelected: selection.defaultSelected === true,
        dependencies: stringArray(raw.dependencies),
        conflicts: stringArray(raw.conflicts),
        downloadBytes: finiteNumber(size.downloadBytes),
        installedVersion: typeof raw.installedVersion === 'string' && raw.installedVersion ? raw.installedVersion : null,
        bundled: raw.bundled === true,
    };
}

export function toSelectionEntries(raw: unknown[]): SelectionEntry[] {
    const entries: SelectionEntry[] = [];
    const seen = new Set<string>();
    for (const row of raw) {
        const entry = toSelectionEntry(row);
        if (!entry || seen.has(entry.id)) continue;
        seen.add(entry.id);
        entries.push(entry);
    }
    return entries;
}

/** Entries the wizard is allowed to offer as a choice (hidden ones only come along as dependencies). */
export function selectableEntries(entries: SelectionEntry[]): SelectionEntry[] {
    return entries.filter(e => e.tier !== 'hidden');
}

export function isLocked(entry: SelectionEntry): boolean {
    return entry.tier === 'essential';
}

// ── Questions ─────────────────────────────────────────────────────────────

export interface QuestionOption {
    id: string;
    label: string;
}

export interface WizardQuestions {
    instruments: QuestionOption[];
    categories: QuestionOption[];
}

/** `import_export` → `Import Export`, `practice` → `Practice`. Presentation only. */
export function labelForTag(tag: string): string {
    return String(tag)
        .split(/[_\-\s]+/)
        .filter(Boolean)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

/**
 * The question list is whatever the catalog offers: every instrument tag and
 * every category used by a selectable entry, alphabetically. A catalog that
 * grows a new instrument or feature category gets a new question for free.
 */
export function buildWizardQuestions(entries: SelectionEntry[]): WizardQuestions {
    const instruments = new Set<string>();
    const categories = new Set<string>();
    for (const entry of selectableEntries(entries)) {
        for (const instrument of entry.instruments) instruments.add(instrument);
        if (entry.category) categories.add(entry.category);
    }
    const options = (values: Set<string>): QuestionOption[] =>
        [...values].sort().map(id => ({ id, label: labelForTag(id) }));
    return { instruments: options(instruments), categories: options(categories) };
}

// ── Recommendation ────────────────────────────────────────────────────────

export interface WizardAnswers {
    instruments: string[];
    categories: string[];
}

export function emptyAnswers(): WizardAnswers {
    return { instruments: [], categories: [] };
}

function normalizeAnswers(raw: unknown, questions: WizardQuestions): WizardAnswers {
    const known = new Set<string>([
        ...questions.instruments.map(o => o.id),
        ...questions.categories.map(o => o.id),
    ]);
    const keep = (value: unknown): string[] =>
        stringArray(value).filter(id => known.has(id));
    const asObject = isObject(raw) ? raw : {};
    return { instruments: keep(asObject.instruments), categories: keep(asObject.categories) };
}

/**
 * The recommended ids for a set of answers:
 *   - `essential` entries always (they are part of the app, not a choice);
 *   - entries the catalog marks `defaultSelected` always;
 *   - entries tagged with one of the chosen instruments;
 *   - instrument-agnostic entries (empty `instruments`) once the user has said
 *     they play something — they apply to any instrument;
 *   - entries in one of the chosen categories.
 *
 * Conflicts and dependencies are resolved afterwards by resolveSelection().
 */
export function recommendIds(entries: SelectionEntry[], answers: WizardAnswers): string[] {
    const chosen = new Set(answers.instruments);
    const chosenCategories = new Set(answers.categories);
    const ids: string[] = [];
    for (const entry of entries) {
        // Hidden entries are never offered or recommended — they only ever come
        // along as somebody else's dependency.
        if (entry.tier === 'hidden') continue;
        const byInstrument = chosen.size > 0 && (
            entry.instruments.length === 0 || entry.instruments.some(i => chosen.has(i))
        );
        const byCategory = entry.category !== '' && chosenCategories.has(entry.category);
        if (entry.tier === 'essential' || entry.defaultSelected || byInstrument || byCategory) {
            ids.push(entry.id);
        }
    }
    return ids;
}

// ── Resolution ────────────────────────────────────────────────────────────

export interface SelectionPlan {
    /** Final install order: dependencies first, then the rest. */
    ids: string[];
    /** Dependency ids pulled in automatically, keyed by the entry that needs them. */
    required: Record<string, string[]>;
    /** Entries the user picked explicitly (may include auto-added dependencies). */
    optional: string[];
    /** Entries dropped because they conflicted, or because their dependency was dropped. */
    conflicts: Array<{ kept: string | null; dropped: string }>;
    /** Total pinned download size of the resolved set. */
    downloadBytes: number;
}

function conflictsWith(entries: Map<string, SelectionEntry>, a: string, b: string): boolean {
    const first = entries.get(a);
    const second = entries.get(b);
    if (!first || !second) return false;
    // Conflicts may be declared one-sidedly, so both arms are checked.
    return first.conflicts.includes(b) || second.conflicts.includes(a);
}

/**
 * Resolve a raw selection into the install plan:
 *
 *  1. dependency closure, emitted dependencies-first so the batch installer
 *     (and the user reading the list) sees prerequisites before dependents;
 *  2. conflict pruning over that order — auto-added dependencies are considered
 *     before `essential` entries and those before plain preferences, so a
 *     mandatory component always wins over a preference that clashes with it,
 *     and the app's own essentials are never the ones dropped;
 *  3. cascade: an entry whose dependency was dropped is dropped with it
 *     (installing it would fail on a missing prerequisite anyway).
 */
export function resolveSelection(entries: SelectionEntry[], ids: string[]): SelectionPlan {
    const byId = new Map(entries.map(e => [e.id, e]));
    const wanted: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
        if (typeof id !== 'string' || seen.has(id) || !byId.has(id)) continue;
        seen.add(id);
        wanted.push(id);
    }

    const required: Record<string, string[]> = {};
    const ordered: string[] = [];
    const visited = new Set<string>();
    const visit = (id: string): void => {
        if (visited.has(id)) return;
        visited.add(id);
        const entry = byId.get(id);
        if (!entry) return;
        for (const dep of entry.dependencies) {
            if (!byId.has(dep)) continue;
            // Record the dependency before descending, so a dep of a dep is
            // attributed to its own parent instead of being listed twice.
            if (!visited.has(dep) && !seen.has(dep)) required[id] = [...(required[id] ?? []), dep];
            visit(dep);
        }
        ordered.push(id);
    };
    wanted.forEach(visit);

    // Precedence for the conflict pass: pulled-in dependencies, then essentials,
    // then everything else in dependency-first order. The sort is stable, so
    // entries of equal rank keep their dependency-first order.
    const rank = (id: string): number => {
        if (!seen.has(id)) return 0;
        return isLocked(byId.get(id)!) ? 1 : 2;
    };
    ordered.sort((a, b) => rank(a) - rank(b));

    const conflicts: Array<{ kept: string | null; dropped: string }> = [];
    const dropped = new Set<string>();
    const kept: string[] = [];
    for (const id of ordered) {
        const blocker = kept.find(other => conflictsWith(byId, id, other));
        if (blocker) {
            dropped.add(id);
            conflicts.push({ kept: blocker, dropped: id });
            continue;
        }
        kept.push(id);
    }
    // Cascade: anything depending on a dropped entry goes with it.
    let grew = true;
    while (grew) {
        grew = false;
        for (const id of kept) {
            const entry = byId.get(id)!;
            const lost = entry.dependencies.find(dep => dropped.has(dep));
            if (lost) {
                dropped.add(id);
                conflicts.push({ kept: null, dropped: id });
                const index = kept.indexOf(id);
                if (index >= 0) kept.splice(index, 1);
                grew = true;
            }
        }
    }

    // A dropped entry takes its own "required by" note with it, and any edge
    // pointing at a dropped dependency is meaningless now.
    const requiredKept: Record<string, string[]> = {};
    for (const [id, deps] of Object.entries(required)) {
        if (dropped.has(id)) continue;
        const live = deps.filter(dep => !dropped.has(dep));
        if (live.length) requiredKept[id] = live;
    }

    return {
        ids: kept,
        required: requiredKept,
        optional: wanted.filter(id => !dropped.has(id)),
        conflicts,
        downloadBytes: kept.reduce((sum, id) => sum + byId.get(id)!.downloadBytes, 0),
    };
}

export interface WizardPreview {
    questions: WizardQuestions;
    /** Recommended (checked-by-default) ids for the given answers. */
    recommended: string[];
    plan: SelectionPlan;
}

export function previewSelection(entries: SelectionEntry[], rawAnswers: unknown): WizardPreview {
    const questions = buildWizardQuestions(entries);
    const answers = normalizeAnswers(rawAnswers, questions);
    const recommended = recommendIds(entries, answers);
    return { questions, recommended, plan: resolveSelection(entries, recommended) };
}
