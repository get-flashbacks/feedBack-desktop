// Minimal preload for the first-run plugin setup wizard (issue #5).
//
// The wizard is its own document, so it gets its own bridge instead of the
// full desktop one: it only needs to read catalog state, resolve/print the
// recommendation and drive the install batch it just started. Nothing here can
// touch the audio engine, the destructive maintenance actions or the app menu.
//
// It exposes the same `window.feedBackDesktop` shape as the main preload, with
// only the two namespaces wizard.js actually uses, so the page needs no
// special-casing (see src/main/wizard.js).

const { contextBridge, ipcRenderer } = require('electron');
import type { InstallProgress } from './plugin-installer';
import {
    IPC_PLUGIN_CATALOG_CANCEL,
    IPC_PLUGIN_CATALOG_PROGRESS,
    IPC_PLUGIN_WIZARD_FINISH,
    IPC_PLUGIN_WIZARD_GET_STATE,
    IPC_PLUGIN_WIZARD_INSTALL,
    IPC_PLUGIN_WIZARD_OPEN,
    IPC_PLUGIN_WIZARD_PREVIEW,
    IPC_PLUGIN_WIZARD_RESOLVE,
} from './ipc-channels';

contextBridge.exposeInMainWorld('feedBackDesktop', {
    isDesktop: true,

    plugins: {
        cancelCatalogInstall: () => ipcRenderer.invoke(IPC_PLUGIN_CATALOG_CANCEL),
        onInstallProgress: (callback: (progress: InstallProgress) => void): (() => void) => {
            const listener = (_event: unknown, progress: InstallProgress) => callback(progress);
            ipcRenderer.on(IPC_PLUGIN_CATALOG_PROGRESS, listener);
            return () => ipcRenderer.removeListener(IPC_PLUGIN_CATALOG_PROGRESS, listener);
        },
    },

    pluginWizard: {
        open: () => ipcRenderer.invoke(IPC_PLUGIN_WIZARD_OPEN),
        getState: () => ipcRenderer.invoke(IPC_PLUGIN_WIZARD_GET_STATE),
        preview: (answers: { instruments: string[]; categories: string[] }) =>
            ipcRenderer.invoke(IPC_PLUGIN_WIZARD_PREVIEW, answers),
        resolve: (ids: string[]) => ipcRenderer.invoke(IPC_PLUGIN_WIZARD_RESOLVE, ids),
        install: (ids: string[]) => ipcRenderer.invoke(IPC_PLUGIN_WIZARD_INSTALL, ids),
        finish: (payload: { skipped: boolean }) => ipcRenderer.invoke(IPC_PLUGIN_WIZARD_FINISH, payload),
    },
});

export {};
