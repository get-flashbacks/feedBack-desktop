// Onboarding state machine for the first-run setup wizard (issue #5).
//
// `completed` / `pendingIds` live in the desktop config, but every decision
// about *when the wizard appears* and *what a window close means* is a
// transition over that small state object — so it lives here, free of Electron,
// and plugin-wizard.ts is left with the window, the IPC and the config writes.
// Same split as plugin-selection.ts: the decisions are testable, the plumbing
// is not.

export interface SetupState {
    /** The wizard was finished *or* explicitly skipped, so it must not reappear. */
    completed: boolean;
    /** What an interrupted run still owes; empty unless a batch did not land. */
    pendingIds: string[];
}

const FIRST_RUN: SetupState = { completed: false, pendingIds: [] };

/** Normalize whatever the config holds — absent, partial or damaged — into a state. */
export function readSetupState(raw: unknown): SetupState {
    if (typeof raw !== 'object' || raw === null) return FIRST_RUN;
    const cfg = raw as { completed?: unknown; pendingIds?: unknown };
    return {
        completed: cfg.completed === true,
        pendingIds: Array.isArray(cfg.pendingIds) ? cfg.pendingIds.filter(id => typeof id === 'string') : [],
    };
}

/** First run is "the wizard has never been finished or explicitly skipped". */
export function isOnboardingNeeded(setup: SetupState): boolean {
    return !setup.completed;
}

export interface CloseContext {
    /** A batch is installing, so the close interrupted a run rather than ended one. */
    installRunning: boolean;
    /**
     * The app itself is going away — a quit, or the renderer startup giving up.
     * The wizard window goes with it without the user having asked.
     */
    goingAway: boolean;
}

/**
 * What closing the wizard window leaves behind, or null to leave the state
 * untouched.
 *
 * A close the user made themselves is the skip path, and it is the *only* way
 * out of a resume whose batch keeps failing: `pendingIds` staying non-empty
 * would otherwise re-prompt on every launch with nothing the user can do about
 * it. A close the app caused is not a decision at all — recording it would
 * consume onboarding the user never finished, on a launch that never worked.
 */
export function stateAfterClose(setup: SetupState, ctx: CloseContext): SetupState | null {
    if (ctx.installRunning || ctx.goingAway) return null;
    if (setup.completed) return null;
    return { completed: true, pendingIds: [] };
}

export interface AutoOpenContext {
    /** "Is this URL exactly the renderer origin?" — the paint check's predicate. */
    isRendererOrigin: (url: string) => boolean;
    /** Re-read per event: onboarding may have been answered since registration. */
    onboardingNeeded: boolean;
}

/**
 * Whether a `did-finish-load` on the main window is the app becoming usable —
 * the only moment worth putting the first-run wizard on top of.
 *
 * The origin gate is not decoration. Chromium fires the event for its built-in
 * error pages too, and main.ts re-issues `loadURL` on every `did-fail-load`
 * retry, so on a slow first start the event that fires first is the error page
 * committing, with the real paint a retry away. Gating on the committed URL is
 * what the sibling handler in createWindow does for the same reason.
 */
export function shouldAutoOpenWizard(url: string, ctx: AutoOpenContext): boolean {
    return ctx.onboardingNeeded && ctx.isRendererOrigin(url);
}