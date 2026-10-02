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
    // webSecurity:false, so every catalog field and every main-process error
    // string below goes through here first. (The git-installed list further down
    // predates this helper and still interpolates unescaped.)
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
                const div = document.createElement('div');
                div.className = 'flex items-center gap-3 p-3 rounded bg-slate-800/50 border border-slate-700';

                const name = plugin.manifest?.name || plugin.name;
                const desc = plugin.manifest?.description || '';
                const version = plugin.version || 'unknown';

                div.innerHTML = `
                    <div class="flex-1">
                        <div class="text-sm font-medium text-slate-200">${name}</div>
                        <div class="text-xs text-slate-400">${desc}</div>
                        <div class="text-xs text-slate-500 mt-0.5">v${version}</div>
                    </div>
                    <div class="flex gap-2">
                        ${plugin.hasGit ? `<button class="pm-update text-xs px-2 py-1 rounded bg-blue-600 hover:bg-blue-500" data-name="${plugin.name}">Update</button>` : ''}
                        <button class="pm-remove text-xs px-2 py-1 rounded bg-red-600/50 hover:bg-red-500" data-name="${plugin.name}">Remove</button>
                    </div>
                `;
                listContainer.appendChild(div);
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
            listContainer.innerHTML = `<div class="text-sm text-red-400">Error loading plugins: ${e.message}</div>`;
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
    // pmCatalogState, pmCatalogHaystack, pmCatalogFacets and pmFilterCatalog
    // carry the pm prefix because they are deliberately free of any reference
    // to the IIFE scope above: tests/plugin-catalog-view.test.js lifts them out
    // of this file and pins the search and filter semantics without a DOM.
    // Keep them that way — in particular, no template literals inside them,
    // since a brace-counting extractor reads their source text.

    // Whether an entry is present on this machine, and whether the catalog pins a
    // different version than the one in use. A bundled copy is the one the
    // backend loads ahead of any user copy — the _is_bundled rule that
    // scanPluginDir in src/main/plugin-manager.ts mirrors — so it decides on its
    // own and is never reported as upgradable: a bundled plugin can only change
    // with a new desktop build, and the catalog installer refuses those ids
    // outright. A user copy installed through git need not carry a version in
    // its manifest, which is a copy present but not comparable.
    function pmCatalogState(entry) {
        if (entry.bundled) return 'installed';
        if (entry.installedVersion == null) return 'available';
        if (!entry.installedVersion) return 'installed';
        return entry.installedVersion === entry.version ? 'installed' : 'update-available';
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

    const CATALOG_STATE_CLASSES = {
        installed: 'bg-emerald-900/40 text-emerald-300',
        'update-available': 'bg-amber-900/40 text-amber-300',
        available: 'bg-slate-700 text-slate-300',
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
            const state = pmCatalogState(entry);
            return `
                <div class="p-3 rounded bg-slate-800/50 border border-slate-700">
                    <div class="flex items-center justify-between gap-2">
                        <div class="text-sm font-medium text-slate-200">${esc(entry.name)}</div>
                        <span class="text-xs px-2 py-0.5 rounded whitespace-nowrap ${CATALOG_STATE_CLASSES[state] || ''}">${esc(catalogValueLabel(state))}</span>
                    </div>
                    <div class="text-xs text-slate-400 mt-0.5">${esc(entry.description)}</div>
                    <div class="text-xs text-slate-500 mt-0.5">v${esc(entry.version)}</div>
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
        });
    }

    // Initial load
    refreshList();
    loadCatalog();
})();
