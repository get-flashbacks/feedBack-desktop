// Plugin Manager UI
(function() {
    'use strict';

    const plugins = window.feedBackDesktop?.plugins;
    if (!plugins) {
        const panel = document.getElementById('plugin-manager-panel');
        if (panel) panel.innerHTML = '<div class="p-8 text-center text-slate-400">Plugin manager is only available in the fee[dB]ack desktop app.</div>';
        return;
    }

    const $ = (id) => document.getElementById(id);

    // Escape before interpolating into innerHTML — this renderer runs with
    // webSecurity:false, so every catalog field, LAN URL and main-process error
    // string (extraNote, catalog load errors) below goes through here first.
    // (The git-installed list further down predates this helper and still
    // interpolates unescaped.)
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));

    const gitUrlInput = $('pm-git-url');
    const installBtn = $('pm-install-btn');
    const installMsg = $('pm-install-msg');
    const listContainer = $('pm-list');
    const refreshBtn = $('pm-refresh');

    function showMessage(msg, success) {
        installMsg.textContent = msg;
        installMsg.className = `mt-2 text-sm ${success ? 'text-emerald-400' : 'text-red-400'}`;
        installMsg.classList.remove('hidden');
        setTimeout(() => installMsg.classList.add('hidden'), 5000);
    }

    // A git-installed plugin's metadata comes from the plugin.json of whatever
    // repository the user cloned, so the name and description are attacker-chosen
    // text. They go in as textContent and the buttons carry their target in
    // `dataset`, so nothing here ever becomes markup — this renderer runs with
    // webSecurity:false, so a stray `<` would execute rather than being inert.
    function installedRow(plugin) {
        const div = document.createElement('div');
        div.className = 'flex items-center gap-3 p-3 rounded bg-slate-800/50 border border-slate-700';

        const meta = document.createElement('div');
        meta.className = 'flex-1';

        const name = document.createElement('div');
        name.className = 'text-sm font-medium text-slate-200';
        name.textContent = plugin.manifest?.name || plugin.name;

        const desc = document.createElement('div');
        desc.className = 'text-xs text-slate-400';
        desc.textContent = plugin.manifest?.description || '';

        const version = document.createElement('div');
        version.className = 'text-xs text-slate-500 mt-0.5';
        version.textContent = 'v' + (plugin.version || 'unknown');

        meta.appendChild(name);
        meta.appendChild(desc);
        meta.appendChild(version);
        div.appendChild(meta);

        const actions = document.createElement('div');
        actions.className = 'flex gap-2';
        if (plugin.hasGit) {
            actions.appendChild(installedAction('pm-update text-xs px-2 py-1 rounded bg-blue-600 hover:bg-blue-500', plugin.name, 'Update'));
        }
        actions.appendChild(installedAction('pm-remove text-xs px-2 py-1 rounded bg-red-600/50 hover:bg-red-500', plugin.name, 'Remove'));
        div.appendChild(actions);

        return div;
    }

    function installedAction(className, name, label) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.textContent = label;
        button.dataset.name = name;
        return button;
    }

    async function refreshList() {
        listContainer.innerHTML = '<div class="text-sm text-slate-500">Loading...</div>';

        try {
            const installed = await plugins.listInstalled();

            if (installed.length === 0) {
                listContainer.innerHTML = '<div class="text-sm text-slate-500 italic">No user-installed plugins. Official plugins are loaded from the fee[dB]ack server.</div>';
                return;
            }

            listContainer.innerHTML = '';
            for (const plugin of installed) {
                listContainer.appendChild(installedRow(plugin));
            }

            // Bind update buttons
            listContainer.querySelectorAll('.pm-update').forEach(btn => {
                btn.addEventListener('click', async () => {
                    btn.disabled = true;
                    btn.textContent = 'Updating...';
                    const result = await plugins.update(btn.dataset.name);
                    showMessage(result.message, result.success);
                    await refreshAll();
                });
            });

            // Bind remove buttons
            listContainer.querySelectorAll('.pm-remove').forEach(btn => {
                btn.addEventListener('click', async () => {
                    if (!confirm(`Remove plugin "${btn.dataset.name}"?`)) return;
                    btn.disabled = true;
                    const result = await plugins.remove(btn.dataset.name);
                    showMessage(result.message, result.success);
                    await refreshAll();
                });
            });
        } catch (e) {
            const error = document.createElement('div');
            error.className = 'text-sm text-red-400';
            // The message comes back across the bridge from main, so it is text
            // rather than markup here too.
            error.textContent = 'Error loading plugins: ' + (e?.message || e);
            listContainer.innerHTML = '';
            listContainer.appendChild(error);
        }
    }

    // An installed copy shows up in both lists, so they always refresh
    // together. loadCatalog() is declared further down; both hoisted.
    async function refreshAll() {
        await refreshList();
        await loadCatalog();
    }

    // Install
    installBtn.addEventListener('click', async () => {
        const url = gitUrlInput.value.trim();
        if (!url) return;

        installBtn.disabled = true;
        installBtn.textContent = 'Installing...';

        try {
            const result = await plugins.install(url);
            showMessage(result.message, result.success);
            if (result.success) {
                gitUrlInput.value = '';
                await refreshAll();
            }
        } catch (e) {
            showMessage('Error: ' + e.message, false);
        }

        installBtn.disabled = false;
        installBtn.textContent = 'Install';
    });

    // Refresh — both the git-installed list and the catalog carry install state.
    refreshBtn.addEventListener('click', refreshAll);

    // ── Curated plugin catalog ────────────────────────────────────────────
    // Same catalog the first-run setup wizard offers, so everything stays
    // reachable after onboarding (issue #5).
    const wizard = window.feedBackDesktop?.pluginWizard;
    const catalogBox = $('pm-catalog');
    const catalogInstallBtn = $('pm-catalog-install');
    const catalogCancelBtn = $('pm-catalog-cancel');
    const catalogProgressWrap = $('pm-catalog-progress-wrap');
    const catalogProgress = $('pm-catalog-progress');
    const catalogProgressText = $('pm-catalog-progress-text');
    const catalogMsg = $('pm-catalog-msg');
    const catalogSelection = new Set();
    const catalogState = new Map(); // id -> {received, total}
    const catalogDependencyInfo = $('pm-catalog-deps');
    let catalogBusy = false;

    function showCatalogMessage(msg, success) {
        if (!catalogMsg) return;
        catalogMsg.textContent = msg;
        catalogMsg.className = `mt-2 text-sm ${success ? 'text-emerald-400' : 'text-red-400'}`;
        catalogMsg.classList.remove('hidden');
    }

    function renderCatalogProgress(name, percent) {
        if (!catalogProgressWrap) return;
        catalogProgressWrap.classList.remove('hidden');
        catalogProgress.value = percent;
        catalogProgressText.textContent = percent >= 100
            ? `${name} — installed.`
            : `${name} — downloading… ${percent}%`;
    }

    function setCatalogBusy(busy) {
        catalogBusy = busy;
        catalogInstallBtn.disabled = busy;
        catalogInstallBtn.textContent = busy ? 'Installing…' : 'Install selected';
        catalogCancelBtn.classList.toggle('hidden', !busy);
    }

    async function refreshCatalog() {
        if (!catalogBox) return;
        try {
            // The bridge answers { ok, entries } — the same shape the browse
            // list above reads. A bare array is what older callers hand back,
            // so both are accepted rather than one of the two lists lying.
            const result = await plugins.catalog();
            const catalog = Array.isArray(result) ? result : (result && Array.isArray(result.entries) ? result.entries : []);
            if (!catalog.length) {
                // A catalog that could not be read says so; "no plugins in this
                // build" would be a different, and wrong, thing to say.
                catalogBox.innerHTML = result && result.ok === false && result.message
                    ? `<div class="text-sm text-red-400">${esc(result.message)}</div>`
                    : '<div class="text-sm text-slate-500 italic">No catalog plugins are available in this build.</div>';
                return;
            }
            catalogBox.innerHTML = '';
            for (const entry of catalog) {
                const selection = entry.selection || {};
                // An entry with a different installed version is an upgrade, not
                // a reinstall: the batch installer swaps it in with a backup slot.
                const outdated = !!entry.installedVersion && entry.installedVersion !== entry.version;
                const installable = !entry.installedVersion || outdated;
                const row = document.createElement('label');
                // Anything installed reads as installed, whether or not the
                // catalog has something newer to offer.
                row.className = `flex items-start gap-3 flex-wrap p-3 rounded border ${entry.installedVersion ? 'bg-emerald-900/20 border-emerald-800' : 'bg-slate-800/50 border-slate-700'}`;

                const box = document.createElement('input');
                box.type = 'checkbox';
                box.className = 'mt-1 accent-emerald-500';
                // Essentials ship with the app, and bundled entries ship with the
                // app too — the installer refuses to place a second copy.
                // A pinned or disabled plugin is installed too, and main refuses to
                // install another version over either: the row offers Pin/Unpin or
                // Enable instead, so the checkbox is off rather than a dead end.
                // A copy the catalog is behind is refused the same way — that
                // install is a downgrade, and the row offers Downgrade instead.
                const held = !!entry.pinned || !!entry.disabled || entry.updateStatus === 'ahead';
                box.disabled = !installable || entry.bundled || selection.tier === 'essential' || held;
                if (box.disabled) catalogSelection.delete(entry.id);
                box.checked = catalogSelection.has(entry.id);
                box.addEventListener('change', async () => {
                    if (box.checked) catalogSelection.add(entry.id);
                    else catalogSelection.delete(entry.id);
                    updateInstallLabel();
                    await updateDependencyInfo();
                });

                const meta = document.createElement('div');
                meta.className = 'flex-1 min-w-0';
                meta.innerHTML = `
                    <div class="flex items-center gap-2 flex-wrap">
                        <span class="text-sm font-medium text-slate-200">${esc(entry.name)}</span>
                        <span class="text-xs text-slate-500">v${esc(entry.version)}</span>
                        ${selection.tier === 'essential' ? '<span class="text-xs text-sky-300">Essential</span>' : ''}
                        ${entry.bundled ? '<span class="text-xs text-sky-300">Included</span>' : ''}
                        ${entry.installedVersion ? `<span class="text-xs text-emerald-400">Installed v${esc(entry.installedVersion)}</span>` : ''}
                        ${lifecycleBadge(entry)}
                        ${entry.canRollback ? '<span class="text-xs text-amber-300">Previous version available</span>' : ''}
                    </div>
                    <div class="text-xs text-slate-400 mt-0.5">${esc(entry.description || '')}</div>
                    <div class="text-xs text-slate-500 mt-0.5">
                        ${esc(entry.category || '')}${Array.isArray(entry.instruments) && entry.instruments.length ? ' · ' + esc(entry.instruments.join(', ')) : ''}
                        ${entry.size ? ' · ' + Math.max(1, Math.round(entry.size.downloadBytes / 1024)) + ' KB' : ''}
                    </div>
                `;

                row.appendChild(box);
                row.appendChild(meta);
                for (const control of lifecycleControls(entry)) row.appendChild(control);

                if (entry.canRollback) {
                    const restore = document.createElement('button');
                    restore.className = 'text-xs px-2 py-1 rounded bg-amber-600/50 hover:bg-amber-500 self-center';
                    restore.textContent = 'Restore previous';
                    restore.addEventListener('click', async (event) => {
                        // The row is a <label> for the install checkbox.
                        event.preventDefault();
                        event.stopPropagation();
                        restore.disabled = true;
                        const res = await plugins.rollbackCatalog(entry.id);
                        showCatalogMessage(res.message, res.success);
                        await refreshCatalog();
                    });
                    row.appendChild(restore);
                }

                catalogBox.appendChild(row);
            }
            updateInstallLabel();
            // One resolve for the whole list, once the rows have settled the
            // selection between them: built row by row, the same call would
            // fire per checkbox against a half-built selection, and every
            // answer after the first would be a race.
            await updateDependencyInfo();
            await updateCheckBadge();
        } catch (e) {
            catalogBox.innerHTML = `<div class="text-sm text-red-400">Error loading the plugin catalog: ${esc(e?.message || e)}</div>`;
        }
    }

    // ── Per-plugin lifecycle controls (issue #21) ─────────────────────────
    // Each button is only rendered for the state it applies to, so the screen
    // cannot offer an operation the main process would refuse — and the refusal
    // message from main is what the user sees if the state changed underneath.
    const checkBadge = $('pm-update-check');

    function lifecycleBadge(entry) {
        const badges = [];
        if (entry.installed && entry.disabled) badges.push('<span class="text-xs text-slate-400">Disabled</span>');
        if (entry.pinned) badges.push(`<span class="text-xs text-sky-300">Pinned at v${esc(entry.installedVersion || '')}</span>`);
        else if (entry.updateStatus === 'available') badges.push(`<span class="text-xs text-amber-300">Update available: v${esc(entry.version)}</span>`);
        else if (entry.updateStatus === 'republished') badges.push('<span class="text-xs text-amber-300">This version was re-published</span>');
        else if (entry.updateStatus === 'ahead') badges.push('<span class="text-xs text-amber-300">The catalog is behind this copy</span>');
        return badges.join(' ');
    }

    function lifecycleControl(label, className, title, run) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `text-xs px-2 py-1 rounded self-center whitespace-nowrap ${className}`;
        button.textContent = label;
        button.title = title;
        button.addEventListener('click', async (event) => {
            // The row is a <label> for the install checkbox; a button inside it
            // would otherwise also toggle that checkbox.
            event.preventDefault();
            event.stopPropagation();
            const idle = button.textContent;
            button.disabled = true;
            button.textContent = 'Working…';
            try {
                const res = await run();
                showCatalogMessage(res && res.message ? res.message : 'Done.', !(res && res.success === false));
            } catch (e) {
                showCatalogMessage('Error: ' + (e?.message || e), false);
            } finally {
                button.disabled = false;
                button.textContent = idle;
                await refreshCatalog();
                await refreshList();
            }
        });
        return button;
    }

    function lifecycleControls(entry) {
        const controls = [];
        if (!entry.installed) return controls;
        if (entry.updateAvailable) {
            controls.push(lifecycleControl(
                'Update',
                'bg-blue-600 hover:bg-blue-500',
                `Install ${entry.name} ${entry.version} over ${entry.installedVersion}`,
                () => plugins.updateCatalog(entry.id),
            ));
        }
        if (entry.pinned) {
            controls.push(lifecycleControl(
                'Unpin',
                'bg-sky-700 hover:bg-sky-600',
                'Let update checks offer newer versions again',
                () => plugins.pinCatalog(entry.id, false),
            ));
        } else if (!entry.disabled) {
            controls.push(lifecycleControl(
                'Pin',
                'bg-slate-600 hover:bg-slate-500',
                `Keep version ${entry.installedVersion} even when a newer one is published`,
                () => plugins.pinCatalog(entry.id, true),
            ));
        }
        for (const version of Array.isArray(entry.downgradeVersions) ? entry.downgradeVersions : []) {
            controls.push(lifecycleControl(
                `Downgrade ${version}`,
                'bg-amber-600/50 hover:bg-amber-500',
                `Reinstall the recorded version ${version}`,
                () => plugins.downgradeCatalog(entry.id, version),
            ));
        }
        controls.push(lifecycleControl(
            entry.disabled ? 'Enable' : 'Disable',
            entry.disabled ? 'bg-emerald-700 hover:bg-emerald-600' : 'bg-slate-700 hover:bg-slate-600',
            entry.disabled
                ? 'Move the plugin back so the server loads it again'
                : 'Stop the server loading this plugin, keeping its files and settings',
            () => plugins.setEnabled(entry.id, !entry.disabled),
        ));
        controls.push(lifecycleControl(
            'Uninstall',
            'bg-red-600/50 hover:bg-red-500',
            'Remove the plugin. You are asked whether to delete its data too.',
            () => plugins.uninstallCatalog(entry.id),
        ));
        return controls;
    }

    async function updateCheckBadge() {
        if (!checkBadge || typeof plugins.checkUpdates !== 'function') return;
        try {
            const result = await plugins.checkUpdates();
            const count = result && typeof result.count === 'number' ? result.count : 0;
            checkBadge.textContent = count
                ? `${count} plugin${count === 1 ? '' : 's'} can be updated`
                : 'All catalog plugins are up to date';
            checkBadge.className = `text-xs ${count ? 'text-amber-300' : 'text-slate-500'}`;
        } catch {
            checkBadge.textContent = '';
        }
    }

    function updateInstallLabel() {
        const count = catalogSelection.size;
        catalogInstallBtn.textContent = count
            ? `Install selected (${count})`
            : 'Install selected';
    }

    async function updateDependencyInfo() {
        if (!catalogDependencyInfo) return;
        const ids = [...catalogSelection];
        if (!ids.length) {
            catalogDependencyInfo.classList.add('hidden');
            catalogDependencyInfo.textContent = '';
            return;
        }
        try {
            const plan = await plugins.resolveCatalog(ids);
            const req = plan && plan.required ? plan.required : {};
            const added = [];
            for (const id of ids) {
                if (req[id] && req[id].length) {
                    for (const d of req[id]) if (!catalogSelection.has(d) && added.indexOf(d) === -1) added.push(d);
                }
            }
            // What the resolver prunes, said before anything is downloaded. A
            // keeper named is a clash; no keeper is the cascade that followed
            // some other drop.
            const dropped = ((plan && plan.conflicts) || []).filter(c => c && c.dropped);
            const notes = [];
            if (added.length) {
                notes.push('Automatically selected required dependencies: ' + added.join(', ') + '.');
            }
            if (dropped.length) {
                notes.push('Will not install: ' + dropped.map(c => c.kept
                    ? `${c.dropped} conflicts with ${c.kept}`
                    : `${c.dropped} depends on something that was dropped`).join('; ') + '.');
            }
            if (notes.length) {
                catalogDependencyInfo.textContent = notes.join(' ');
                catalogDependencyInfo.classList.remove('hidden');
                return;
            }
            catalogDependencyInfo.classList.add('hidden');
            catalogDependencyInfo.textContent = '';
        } catch (e) {
            catalogDependencyInfo.classList.add('hidden');
            catalogDependencyInfo.textContent = '';
        }
    }

    if (catalogInstallBtn) {
        catalogInstallBtn.addEventListener('click', async () => {
            const ids = [...catalogSelection];
            if (!ids.length) {
                showCatalogMessage('Select at least one plugin to install.', false);
                return;
            }
            setCatalogBusy(true);
            showCatalogMessage('', true);
            const unsubscribe = plugins.onInstallProgress((progress) => {
                const state = catalogState.get(progress.id) || { received: 0, total: 0 };
                if (progress.totalBytes) state.total = progress.totalBytes;
                if (progress.receivedBytes !== undefined) state.received = progress.receivedBytes;
                catalogState.set(progress.id, state);
                const percent = state.total ? Math.round((state.received / state.total) * 100) : 0;
                renderCatalogProgress(progress.name, percent);
            });
            try {
                const result = await plugins.installCatalog(ids);
                const failed = Array.isArray(result.results) ? result.results.filter(r => !r.success) : [];
                for (const item of failed) showCatalogMessage(item.message, false);
                if (!failed.length) showCatalogMessage(result.message, result.success);
                catalogSelection.clear();
                if (catalogDependencyInfo) {
                    catalogDependencyInfo.classList.add('hidden');
                    catalogDependencyInfo.textContent = '';
                }
                await refreshCatalog();
                await refreshList();
            } catch (e) {
                showCatalogMessage('Error: ' + (e.message || e), false);
            } finally {
                unsubscribe();
                catalogState.clear();
                catalogProgressWrap.classList.add('hidden');
                setCatalogBusy(false);
            }
        });
    }

    if (catalogCancelBtn) {
        catalogCancelBtn.addEventListener('click', async () => {
            const res = await plugins.cancelCatalogInstall();
            showCatalogMessage(res.message, res.success);
        });
    }

    if ($('pm-wizard-btn') && wizard) {
        $('pm-wizard-btn').addEventListener('click', async () => {
            const res = await wizard.open();
            if (!res || res.success === false) {
                showCatalogMessage('The setup wizard could not be opened.', false);
            }
        });
    }

    refreshCatalog();

    // ── LAN access toggle ───────────────────────────────────────────────
    const network = window.feedBackDesktop?.network;
    const lanToggle = $('pm-lan-toggle');
    const lanStatus = $('pm-lan-status');

    function renderLanStatus(enabled, urls, extraNote) {
        if (!lanStatus) return;
        if (!enabled) {
            lanStatus.className = 'mt-3 text-xs text-slate-500';
            lanStatus.textContent = extraNote || 'Only this computer can connect.';
            lanStatus.classList.remove('hidden');
            return;
        }
        const list = (urls && urls.length)
            ? urls.map((u) => `<li><code class="text-emerald-300">${esc(u)}</code></li>`).join('')
            : '<li class="text-slate-400 italic">No network address detected — are you connected to Wi-Fi/Ethernet?</li>';
        lanStatus.className = 'mt-3 text-xs text-slate-300';
        lanStatus.innerHTML = `
            ${extraNote ? `<div class="text-amber-300 mb-1">${esc(extraNote)}</div>` : ''}
            <div class="text-slate-400">Other devices on your network can open:</div>
            <ul class="list-disc list-inside mt-1 space-y-0.5">${list}</ul>
            <div class="text-slate-500 mt-2">Your OS firewall may prompt the first time — allow fee[dB]ack so other devices can connect.</div>
        `;
        lanStatus.classList.remove('hidden');
    }

    if (network && lanToggle) {
        network.getLanAccess()
            .then(({ enabled, urls }) => {
                lanToggle.checked = enabled;
                renderLanStatus(enabled, urls);
            })
            .catch(() => { /* leave toggle in default unchecked state */ });

        lanToggle.addEventListener('change', async () => {
            const wanted = lanToggle.checked;
            lanToggle.disabled = true;
            renderLanStatus(wanted, [], 'Restarting server to apply…');
            try {
                const res = await network.setLanAccess(wanted);
                if (res.success === false) {
                    // The request was declined before anything changed, so the
                    // old bind address is still live. res.enabled is the
                    // authoritative state; show it and let the user retry.
                    lanToggle.checked = !!res.enabled;
                    renderLanStatus(!!res.enabled, res.urls || [], res.message);
                    return;
                }
                renderLanStatus(res.enabled, res.urls);
            } catch (e) {
                lanToggle.checked = !wanted; // revert on failure
                renderLanStatus(!wanted, [], 'Failed to change network setting: ' + (e?.message || e));
            } finally {
                lanToggle.disabled = false;
            }
        });
    } else if (lanToggle) {
        lanToggle.disabled = true;
    }

    // ── Plugin catalog: read-only browsing ─────────────────────────────
    //
    // pmCatalogState, pmCatalogBadges, pmCatalogHaystack, pmCatalogFacets and
    // pmFilterCatalog carry the pm prefix because they are deliberately free of
    // any reference to the IIFE scope above: tests/plugin-catalog-view.test.js
    // lifts them out of this file and pins the search, filter and card-badge
    // semantics without a DOM.
    // Keep them that way — in particular, no template literals inside them,
    // since a brace-counting extractor reads their source text.

    // Whether an entry is present on this machine, and whether the catalog pins a
    // different version than the one in use. A bundled copy is the one the
    // backend loads ahead of any user copy — the _is_bundled rule that
    // activeSource in src/main/plugin-precedence.ts mirrors — so it decides on
    // its own and is never reported as upgradable: a bundled plugin can only
    // change with a new desktop build, and the catalog installer refuses those
    // ids outright. A user copy installed through git need not carry a version
    // in its manifest, which is a copy present but not comparable.
    function pmCatalogState(entry) {
        if (entry.bundled) return 'installed';
        if (entry.installedVersion == null) return 'available';
        if (!entry.installedVersion) return 'installed';
        return entry.installedVersion === entry.version ? 'installed' : 'update-available';
    }

    // The badges one card wears, in reading order: whether the entry fits this
    // build at all, then which on-disk copy the backend loads — the
    // installed / bundled / writable-override distinction of
    // src/main/plugin-precedence.ts, reported per row as activeSource (issue
    // #6) — then the install status and the selection tier. The tier badges are
    // what keep a recommendation ("Recommended", indigo) from reading as a hard
    // requirement: "Essential" (sky, locked into every plan) and the card's
    // "Requires:" line are the two answers that are not optional.
    // Plain objects in, plain class strings out, so the lifted test can assert
    // the badge set without a DOM; titles carry the precedence rule in one
    // sentence because "writable override" means nothing without it.
    function pmCatalogBadges(entry) {
        const badges = [];
        if (entry.compat && entry.compat.ok === false) {
            badges.push({ label: 'Incompatible', cls: 'bg-red-900/40 text-red-300' });
        }
        const sources = {
            'bundled': {
                label: 'Bundled',
                cls: 'bg-sky-900/40 text-sky-300',
                title: 'Ships with the app; the packaged copy is the one the backend loads.',
            },
            'writable-override': {
                label: 'Writable override',
                cls: 'bg-violet-900/40 text-violet-300',
                title: 'Your copy shadows a packaged plugin with the same id, so the backend loads yours.',
            },
            'installed': {
                label: 'Installed',
                cls: 'bg-emerald-900/40 text-emerald-300',
                title: 'Installed into your plugins folder; no packaged copy has this id.',
            },
        };
        const source = sources[entry.activeSource];
        if (source) badges.push(source);
        const state = pmCatalogState(entry);
        if (state === 'update-available') badges.push({ label: 'Update available', cls: 'bg-amber-900/40 text-amber-300' });
        // "Available" (nothing on this machine) only fits when no source badge
        // claims presence: activeSource reports 'bundled' for any packaged
        // copy — including one whose manifest does not claim bundled: true —
        // so that row would otherwise wear "Bundled" and "Available" at once,
        // each saying the opposite about whether the plugin is here.
        else if (state === 'available' && !source) badges.push({ label: 'Available', cls: 'bg-slate-700 text-slate-300' });
        const tier = entry.selection ? entry.selection.tier : '';
        if (tier === 'essential') badges.push({ label: 'Essential', cls: 'bg-sky-900/40 text-sky-300' });
        else if (tier === 'recommended') badges.push({ label: 'Recommended', cls: 'bg-indigo-900/40 text-indigo-300' });
        return badges;
    }

    // Everything free-text search looks at, lowercased. Instruments are folded
    // in so "guitar" also finds the entries that list it.
    function pmCatalogHaystack(entry) {
        const parts = [
            entry.name,
            entry.id,
            entry.description,
            entry.category,
            entry.source,
            entry.stability,
            entry.version,
        ];
        for (const instrument of entry.instruments || []) parts.push(instrument);
        return parts.filter(Boolean).join(' ').toLowerCase();
    }

    // The facet options come from the whole catalog, never from the current
    // results, so ticking one value never makes its siblings unreachable.
    function pmCatalogFacets(entries) {
        const sets = {
            category: new Set(),
            instrument: new Set(),
            source: new Set(),
            stability: new Set(),
            state: new Set(),
        };
        for (const entry of entries) {
            sets.category.add(entry.category);
            sets.source.add(entry.source);
            sets.stability.add(entry.stability);
            sets.state.add(pmCatalogState(entry));
            for (const instrument of entry.instruments || []) sets.instrument.add(instrument);
        }
        const sorted = (set) => Array.from(set).filter(Boolean).sort();
        return {
            category: sorted(sets.category),
            instrument: sorted(sets.instrument),
            source: sorted(sets.source),
            stability: sorted(sets.stability),
            state: sorted(sets.state),
        };
    }

    // Every selected facet must match (AND), any value within one facet matches
    // (OR), and a facet with nothing selected is not a constraint. Search terms
    // are ANDed as well, so "piano keys" narrows rather than widens. An entry
    // that declares no instruments matches an instrument filter only by never
    // declaring one — the catalog genuinely says nothing about where it applies.
    function pmFilterCatalog(entries, filters) {
        const terms = (filters.query || '').toLowerCase().split(/\s+/).filter(Boolean);
        const facetMatches = (values, chosen) => (
            !chosen || chosen.size === 0 || values.some((v) => chosen.has(v))
        );
        return entries.filter((entry) => {
            if (terms.length) {
                const haystack = pmCatalogHaystack(entry);
                if (!terms.every((t) => haystack.includes(t))) return false;
            }
            if (!facetMatches([entry.category], filters.category)) return false;
            if (!facetMatches(entry.instruments || [], filters.instrument)) return false;
            if (!facetMatches([entry.source], filters.source)) return false;
            if (!facetMatches([entry.stability], filters.stability)) return false;
            if (!facetMatches([pmCatalogState(entry)], filters.state)) return false;
            return true;
        });
    }

    const CATALOG_FACET_LABELS = {
        category: 'Category',
        instrument: 'Instrument',
        source: 'Source',
        stability: 'Stability',
        state: 'Status',
    };

    // Catalog vocabulary is machine-facing; these read as prose in the filter
    // list and on the row badge. 'get-flashbacks' is an organization name and
    // keeps its own casing; anything not listed here is a single lowercase word
    // that just needs a capital.
    const CATALOG_VALUE_LABELS = {
        'get-flashbacks': 'get-flashbacks',
        'upstream-official': 'Upstream official',
        'reviewed-community': 'Reviewed community',
        'update-available': 'Update available',
    };

    function catalogValueLabel(value) {
        return CATALOG_VALUE_LABELS[value] || String(value).charAt(0).toUpperCase() + String(value).slice(1);
    }

    const catalogSearch = $('pm-catalog-search');
    const catalogFiltersEl = $('pm-catalog-filters');
    const catalogListEl = $('pm-catalog-list');
    const catalogStatusEl = $('pm-catalog-status');
    const catalogCountEl = $('pm-catalog-count');
    const catalogActiveEl = $('pm-catalog-active');
    const catalogClearBtn = $('pm-catalog-clear');

    let catalogEntries = [];
    let catalogError = '';
    const catalogFilters = {
        query: '',
        category: new Set(),
        instrument: new Set(),
        source: new Set(),
        stability: new Set(),
        state: new Set(),
    };

    // A stale or partial screen fragment can be missing these ids. Skip the
    // catalog rather than throwing and taking the install-from-git path and the
    // LAN toggle above down with it.
    const catalogMounted = !!(catalogSearch && catalogFiltersEl && catalogClearBtn
        && catalogListEl && catalogStatusEl && catalogCountEl && catalogActiveEl);

    function activeCatalogFilterCount() {
        let count = (catalogFilters.query || '').trim() ? 1 : 0;
        for (const facet of Object.keys(catalogFilters)) {
            if (facet !== 'query') count += catalogFilters[facet].size;
        }
        return count;
    }

    function renderCatalogFacets(entries) {
        const facets = pmCatalogFacets(entries);
        const groups = [];
        for (const facet of Object.keys(CATALOG_FACET_LABELS)) {
            const values = facets[facet];
            if (!values.length) continue;
            // category and instruments are free-form catalog strings, so the id
            // is the index rather than a slug of the value: two values that slug
            // the same must not share an id, or the second label would drive the
            // first checkbox.
            const options = values.map((value, index) => {
                const id = 'pm-cat-' + facet + '-' + index;
                const checked = catalogFilters[facet].has(value) ? ' checked' : '';
                return `
                    <label class="flex items-center gap-2 text-xs text-slate-300 cursor-pointer" for="${id}">
                        <input type="checkbox" id="${id}" class="accent-emerald-500"
                               data-facet="${facet}" data-value="${esc(value)}"${checked}>
                        <span>${esc(catalogValueLabel(value))}</span>
                    </label>`;
            }).join('');
            groups.push(`
                <fieldset class="rounded border border-slate-700 p-2">
                    <legend class="px-1 text-xs font-semibold text-slate-400">${CATALOG_FACET_LABELS[facet]}</legend>
                    <div class="flex flex-col gap-1">${options}</div>
                </fieldset>`);
        }
        catalogFiltersEl.innerHTML = groups.join('');
    }

    function renderCatalogRows(rows) {
        catalogListEl.innerHTML = rows.map((entry) => {
            const badges = pmCatalogBadges(entry).map((badge) => `
                    <span class="text-xs px-2 py-0.5 rounded whitespace-nowrap ${badge.cls}"${badge.title ? ` title="${esc(badge.title)}"` : ''}>${esc(badge.label)}</span>`).join('');
            // The compatibility verdict comes from main (plugin-compat.ts): ok
            // shows what the entry requires of this build, a failed verdict
            // shows the reason instead — actionable, not just a red mark.
            const compat = entry.compat || {};
            const fit = compat.ok === false
                ? `<div class="text-xs text-red-300 mt-0.5">${esc(compat.reason || 'This plugin does not fit this build.')}</div>`
                : compat.requirements
                    ? `<div class="text-xs text-slate-500 mt-0.5">Requires ${esc(compat.requirements)}</div>`
                    : '';
            // Declared dependencies are hard requirements (the install adds
            // them whether or not anything recommends them), so they get their
            // own line and never share the recommendation badges' styling.
            const requires = Array.isArray(entry.dependencies) && entry.dependencies.length
                ? `<div class="text-xs text-orange-300 mt-0.5">Requires: ${esc(entry.dependencies.join(', '))}</div>`
                : '';
            const meta = [];
            if (entry.category) meta.push(entry.category);
            if (Array.isArray(entry.instruments) && entry.instruments.length) meta.push(entry.instruments.join(', '));
            if (entry.source) meta.push(catalogValueLabel(entry.source));
            if (entry.stability) meta.push(catalogValueLabel(entry.stability));
            if (entry.size && Number.isFinite(entry.size.downloadBytes)) {
                meta.push(Math.max(1, Math.round(entry.size.downloadBytes / 1024)) + ' KB download');
            }
            return `
                <div class="p-3 rounded bg-slate-800/50 border border-slate-700">
                    <div class="flex items-center justify-between gap-2">
                        <div class="text-sm font-medium text-slate-200">${esc(entry.name)} <span class="text-xs text-slate-500 font-normal">v${esc(entry.version)}</span></div>
                        <div class="flex items-center gap-1 flex-wrap justify-end">${badges}</div>
                    </div>
                    <div class="text-xs text-slate-400 mt-0.5">${esc(entry.description)}</div>
                    <div class="text-xs text-slate-500 mt-0.5">${meta.map(esc).join(' · ')}</div>
                    ${fit}
                    ${requires}
                </div>`;
        }).join('');
    }

    function renderCatalog() {
        const active = activeCatalogFilterCount();
        catalogClearBtn.disabled = active === 0;
        catalogClearBtn.classList.toggle('opacity-40', active === 0);

        // A catalog that could not be read stays that way for as long as the
        // user keeps typing and ticking: "the bundled catalog has no plugins"
        // would be a different, and wrong, thing to say.
        if (catalogError) {
            catalogCountEl.textContent = '';
            catalogActiveEl.textContent = '';
            catalogListEl.innerHTML = '';
            catalogStatusEl.innerHTML = '<div class="text-red-400">' + esc(catalogError) + '</div>';
            return;
        }

        const rows = pmFilterCatalog(catalogEntries, catalogFilters);
        catalogCountEl.textContent = catalogEntries.length
            ? rows.length + ' of ' + catalogEntries.length + ' plugins'
            : '';
        catalogActiveEl.textContent = active ? active + (active === 1 ? ' filter active' : ' filters active') : '';

        if (rows.length) {
            renderCatalogRows(rows);
            catalogStatusEl.innerHTML = '';
            return;
        }
        catalogListEl.innerHTML = '';
        catalogStatusEl.innerHTML = catalogEntries.length
            ? '<div class="text-slate-400 italic">No plugins match these filters. Clear them to see the whole catalog.</div>'
            : '<div class="text-slate-500 italic">The bundled catalog has no plugins.</div>';
    }

    function showCatalogError(message) {
        catalogError = message;
        catalogEntries = [];
        // Drop the selection rather than keep it silently: a catalog that could
        // not be read cannot honour it, and there are no checkboxes left to undo
        // it with.
        catalogSearch.value = '';
        catalogFilters.query = '';
        for (const facet of Object.keys(catalogFilters)) {
            if (facet !== 'query') catalogFilters[facet].clear();
        }
        catalogFiltersEl.innerHTML = '';
        renderCatalog();
    }

    // The catalog is read from disk in the main process, so this never needs a
    // network connection; only a missing or damaged bundled file fails.
    async function loadCatalog() {
        if (!catalogMounted) return;
        catalogError = '';
        catalogListEl.innerHTML = '';
        // No facets while loading either: ticking one against the previous
        // catalog would filter a list that is about to be replaced.
        catalogFiltersEl.innerHTML = '';
        catalogStatusEl.innerHTML = '<div class="text-slate-500">Loading catalog…</div>';
        catalogSearch.disabled = true;
        catalogClearBtn.disabled = true;

        try {
            const result = await plugins.catalog();
            if (!result || result.ok !== true) {
                showCatalogError((result && result.message) || 'The plugin catalog is unavailable.');
                return;
            }
            catalogEntries = Array.isArray(result.entries) ? result.entries : [];
            renderCatalogFacets(catalogEntries);
            renderCatalog();
        } catch (e) {
            showCatalogError('Could not load the plugin catalog: ' + (e?.message || e));
        } finally {
            catalogSearch.disabled = false;
        }
    }

    if (catalogMounted) {
        catalogSearch.addEventListener('input', () => {
            catalogFilters.query = catalogSearch.value;
            renderCatalog();
        });

        catalogFiltersEl.addEventListener('change', (event) => {
            const facet = event.target.dataset ? event.target.dataset.facet : '';
            if (!Object.hasOwn(catalogFilters, facet)) return;
            const chosen = catalogFilters[facet];
            if (event.target.checked) chosen.add(event.target.dataset.value);
            else chosen.delete(event.target.dataset.value);
            renderCatalog();
        });

        catalogClearBtn.addEventListener('click', () => {
            catalogSearch.value = '';
            catalogFilters.query = '';
            for (const facet of Object.keys(catalogFilters)) {
                if (facet !== 'query') catalogFilters[facet].clear();
            }
            catalogFiltersEl.querySelectorAll('input[data-facet]').forEach((input) => { input.checked = false; });
            renderCatalog();
            if (catalogDependencyInfo) { catalogDependencyInfo.classList.add('hidden'); catalogDependencyInfo.textContent = ''; }
        });
    }

    // Initial load
    refreshList();
    loadCatalog();
})();
