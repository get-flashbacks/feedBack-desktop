// Central registry of IPC channel names shared between the main process and
// preload scripts. Import this module in both sides so a rename never drifts.

export const IPC_STARTUP_STATUS = 'startup:status' as const;
export const IPC_STARTUP_GET_STATUS = 'startup:getStatus' as const;
export const IPC_STARTUP_REQUEST_STATUS = 'startup:requestStatus' as const;

// Auto-update (Velopack). The renderer (Settings panel + restart banner) reads
// status, switches release channel, kicks a manual check, and applies a
// downloaded update.
export const IPC_UPDATE_GET_STATUS = 'update:getStatus' as const;
export const IPC_UPDATE_SET_CHANNEL = 'update:setChannel' as const;
export const IPC_UPDATE_CHECK_NOW = 'update:checkNow' as const;
export const IPC_UPDATE_APPLY = 'update:apply' as const;

// One-way push events the main side broadcasts to every BrowserWindow via
// webContents.send (not ipcMain.handle channels). Registered here so the
// update-manager broadcaster and the preload listeners can't drift.
export const IPC_UPDATE_EVENT_AVAILABLE = 'update:available' as const;
export const IPC_UPDATE_EVENT_DOWNLOADED = 'update:downloaded' as const;
// Download-progress ticks (Linux AppImage self-update — a full ~1.5GB fetch,
// so the renderer needs a percentage rather than a frozen "checking" state).
export const IPC_UPDATE_EVENT_PROGRESS = 'update:progress' as const;
// Diagnostic trace of main-process update decisions (Linux path). The
// renderer's diagnostics.js already wraps console.* into an exportable ring
// buffer — this event exists purely to get main-process events (invisible to
// that browser-side wrap) into the SAME renderer console, so they end up in
// the same "Export Diagnostics" bundle instead of needing a separate log file.
export const IPC_UPDATE_EVENT_DIAG = 'update:diag' as const;

// Config maintenance — the in-app "Reset / repair configuration" action. The
// Settings panel reads the enumerated per-OS paths, runs a granular reset, and
// asks the main process to relaunch. Replaces the manual "delete the config
// folder" instruction.
export const IPC_MAINTENANCE_GET_PATHS = 'maintenance:getPaths' as const;
export const IPC_MAINTENANCE_RESET = 'maintenance:reset' as const;
export const IPC_MAINTENANCE_RESTART = 'maintenance:restart' as const;

// Screen wake lock. The renderer (slopsmith core app.js) asks the main process
// to keep the display awake while a song plays — embedded Chromium does not
// honour the renderer's navigator.wakeLock reliably, so we drive Electron's
// powerSaveBlocker here instead. See got-feedback/feedback#686.
export const IPC_POWER_SET_SCREEN_AWAKE = 'power:setScreenAwake' as const;

// Main-window fullscreen-at-launch preference. Renderer (Settings → System)
// reads/writes it; main persists it in the desktop config and applies it on
// window creation.
export const IPC_WINDOW_GET_START_FULLSCREEN = 'window:getStartFullscreen' as const;
export const IPC_WINDOW_SET_START_FULLSCREEN = 'window:setStartFullscreen' as const;

// Curated plugin catalog installs (no Git). Progress is pushed to every window
// so both the first-run wizard and the Plugin Manager's catalog list can drive a
// progress bar from the same batch, and cancellation is a single shared
// in-flight abort so the two can never fight over the same download.
export const IPC_PLUGIN_CATALOG_PROGRESS = 'plugins:installCatalogProgress' as const;
export const IPC_PLUGIN_CATALOG_CANCEL = 'plugins:cancelCatalogInstall' as const;

// Per-plugin lifecycle operations (issue #21, lifecycle 2/6). Each one names a
// plugin id — never a URL or a path — and the installed-state record decides what
// may happen to it: a pinned or disabled plugin is not updated, and a downgrade
// only ever reinstalls an archive the record already vouched for.
// `plugins:uninstallCatalog` additionally takes whether the user's data goes
// with it; the main process asks for that separately with a native dialog rather
// than letting the renderer assert it.
export const IPC_PLUGIN_UPDATE_CATALOG = 'plugins:updateCatalog' as const;
export const IPC_PLUGIN_DOWNGRADE_CATALOG = 'plugins:downgradeCatalog' as const;
export const IPC_PLUGIN_PIN_CATALOG = 'plugins:pinCatalog' as const;
export const IPC_PLUGIN_SET_ENABLED = 'plugins:setCatalogEnabled' as const;
export const IPC_PLUGIN_UNINSTALL_CATALOG = 'plugins:uninstallCatalog' as const;
// Update check: which installed plugins the catalog would replace. A pinned or
// disabled plugin is not in the answer, which is how "pinned plugins are
// excluded from update checks" is kept true rather than merely displayed.
export const IPC_PLUGIN_CHECK_UPDATES = 'plugins:checkUpdates' as const;

// First-run guided plugin selection (issue #5). The wizard is a local window
// (src/main/wizard.html) driven over these channels; `open` is what the Plugin
// Manager's "setup wizard" button invokes to bring it back later.
export const IPC_PLUGIN_WIZARD_OPEN = 'pluginWizard:open' as const;
export const IPC_PLUGIN_WIZARD_GET_STATE = 'pluginWizard:getState' as const;
export const IPC_PLUGIN_WIZARD_PREVIEW = 'pluginWizard:preview' as const;
// Re-resolves the current checkboxes after every toggle, so dependencies and
// conflicts update the moment a choice changes.
export const IPC_PLUGIN_WIZARD_RESOLVE = 'pluginWizard:resolve' as const;
export const IPC_PLUGIN_WIZARD_INSTALL = 'pluginWizard:install' as const;
export const IPC_PLUGIN_WIZARD_FINISH = 'pluginWizard:finish' as const;

// Detachable panes (feedBack core's window.feedBack.panes).
//
// Deliberately tiny. The renderer OPENS its own pane windows with window.open() —
// it has to, because it moves a live DOM node into them and needs a handle on the
// new document to do it (see pane-hosts.ts). Electron turns that same-origin
// window.open() into a real BrowserWindow, and main recognises it by its frame
// name. So there is no open/close/focus channel: main never creates or destroys a
// pane window, it only dresses one up.
//
// That leaves exactly two things to say across the boundary.

// Renderer → main: the pane registry, so the tray can list panes it otherwise
// knows nothing about.
export const IPC_PANE_SYNC = 'pane:sync' as const;

// Main → renderer: the tray asked to open or close a pane. Only the renderer knows
// what that means — the pane may belong in the dock, and its element lives there.
export const IPC_PANE_EVENT_TOGGLE = 'pane:toggle' as const;
