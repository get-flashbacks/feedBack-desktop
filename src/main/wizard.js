// First-run guided plugin selection UI (issue #5).
//
// Pure renderer over the preload bridge: the wizard owns no selection logic —
// every question, recommendation, dependency closure and conflict decision comes
// from the main process (plugin-selection.ts), so this file only renders what it
// is told and reports the user's choices back.
(function () {
    'use strict';

    const api = window.feedBackDesktop;
    const $ = (id) => document.getElementById(id);

    if (!api || !api.pluginWizard) {
        document.querySelector('main').innerHTML =
            '<div class="note">Plugin setup is only available in the fee[dB]ack desktop app. '
            + 'You can install plugins from the Plugin Manager.</div>';
        $('btn-primary').disabled = true;
        $('btn-skip').disabled = true;
        return;
    }

    const STEPS = ['welcome', 'questions', 'review', 'progress', 'done'];
    let step = 'welcome';
    let state = null;          // wizard state from the main process
    let entries = [];          // catalog entries (metadata + install state)
    let entriesById = new Map();
    let answers = { instruments: [], categories: [] };
    let checked = new Set();   // ids the user has selected
    let plan = null;           // last resolved plan (ids / required / conflicts)
    let installing = false;

    // ── helpers ───────────────────────────────────────────────────────────

    const stepEl = (name) => $('step-' + name);

    function showStep(name) {
        step = name;
        for (const s of STEPS) stepEl(s).classList.toggle('active', s === name);
        $('btn-back').style.display = name === 'welcome' || name === 'progress' || name === 'done' ? 'none' : '';
        $('btn-skip').style.display = name === 'progress' || name === 'done' ? 'none' : '';
        $('btn-cancel').style.display = name === 'progress' ? '' : 'none';
        $('footer-hint').textContent = hintFor(name);
        const primary = $('btn-primary');
        primary.disabled = false;
        primary.textContent = labelFor(name);
    }

    function labelFor(name) {
        if (name === 'welcome') return 'Get started';
        if (name === 'questions') return 'See suggested plugins';
        if (name === 'review') return checked.size ? `Install ${checked.size} plugin${checked.size === 1 ? '' : 's'}` : 'Continue without installing';
        if (name === 'progress') return installing ? 'Installing…' : 'Continue';
        return 'Continue into fee[dB]ack';
    }

    function hintFor(name) {
        if (name === 'review') return plan ? plan.ids.length + ' will be installed' : '';
        return '';
    }

    function refreshPrimary() {
        const primary = $('btn-primary');
        primary.textContent = labelFor(step);
        primary.disabled = step === 'progress' && installing;
        $('footer-hint').textContent = hintFor(step);
    }

    function formatSize(bytes) {
        const mb = bytes / (1024 * 1024);
        if (mb >= 1) return `${mb.toFixed(1)} MB`;
        if (bytes > 0) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
        return '0 MB';
    }

    function entryOf(id) {
        return entriesById.get(id);
    }

    // What main will actually fetch. An entry already at its pinned version, or
    // bundled with the app, is in the plan but never downloaded, so its bytes
    // must stay out of both the size shown on review and the progress
    // denominator — otherwise the bar can never reach 100%. This mirrors
    // plugin-selection.ts's plan.downloadBytes.
    function needsDownload(entry) {
        return !!entry && !entry.bundled && entry.installedVersion !== entry.version;
    }

    function tag(text, className) {
        const span = document.createElement('span');
        span.className = 'tag' + (className ? ' ' + className : '');
        span.textContent = text;
        return span;
    }

    // ── questions ─────────────────────────────────────────────────────────

    function renderQuestions() {
        const build = (containerId, options, key) => {
            const container = $(containerId).querySelector('.options');
            container.innerHTML = '';
            if (!options.length) {
                $(containerId).style.display = 'none';
                return;
            }
            for (const option of options) {
                const label = document.createElement('label');
                label.className = 'chip';
                const box = document.createElement('input');
                box.type = 'checkbox';
                box.checked = answers[key].includes(option.id);
                box.addEventListener('change', () => {
                    const set = new Set(answers[key]);
                    if (box.checked) set.add(option.id); else set.delete(option.id);
                    answers[key] = [...set];
                    label.classList.toggle('checked', box.checked);
                });
                label.appendChild(box);
                label.appendChild(document.createTextNode(option.label));
                container.appendChild(label);
            }
        };
        build('question-instruments', state.questions.instruments, 'instruments');
        build('question-categories', state.questions.categories, 'categories');
    }

    // ── review ────────────────────────────────────────────────────────────

    function renderReview() {
        const list = $('review-list');
        list.innerHTML = '';
        if (!entries.length) {
            const empty = document.createElement('div');
            empty.className = 'card muted';
            empty.textContent = 'The plugin catalog is unavailable right now. You can add plugins later from the Plugin Manager.';
            list.appendChild(empty);
            $('review-note').textContent = '';
            refreshPrimary();
            return;
        }

        const requiredBy = new Map();
        for (const [id, deps] of Object.entries(plan.required || {})) {
            for (const dep of deps) {
                requiredBy.set(dep, [...(requiredBy.get(dep) || []), id]);
            }
        }
        // A blocked entry (withdrawn / security-blocked) is never offered; it is
        // only listed when something else pulled it into the plan, and the
        // install gate names it if it refuses.
        const visible = entries.filter(e => (e.tier !== 'hidden' && !e.blocked) || plan.ids.includes(e.id));

        for (const entry of visible) {
            const row = document.createElement('div');
            const installed = entry.installedVersion === entry.version;
            // Shipped with the app (bundled), or already at its pinned version:
            // nothing to download, so the choice is not offered.
            const included = installed || entry.bundled;
            row.className = 'row' + (included ? ' installed' : '');
            const isLocked = entry.tier === 'essential' || requiredBy.has(entry.id);

            const box = document.createElement('input');
            box.type = 'checkbox';
            box.checked = checked.has(entry.id);
            box.disabled = included || isLocked;
            box.addEventListener('change', () => {
                if (box.checked) checked.add(entry.id); else checked.delete(entry.id);
                // Dropping a prerequisite drops whatever needed it: the plan
                // resolver would refuse the pair anyway.
                if (!box.checked) {
                    const queue = [entry.id];
                    while (queue.length) {
                        const id = queue.pop();
                        for (const dependent of dependentsOf(id)) {
                            if (checked.delete(dependent)) queue.push(dependent);
                        }
                    }
                }
                resolveAndRender();
            });

            const meta = document.createElement('div');
            meta.className = 'meta';
            const name = document.createElement('div');
            name.className = 'name';
            name.textContent = entry.name;
            meta.appendChild(name);
            if (entry.description) {
                const desc = document.createElement('div');
                desc.className = 'desc';
                desc.textContent = entry.description;
                meta.appendChild(desc);
            }
            const tags = document.createElement('div');
            tags.className = 'tags';
            tags.appendChild(tag(`v${entry.version}`, ''));
            tags.appendChild(tag(formatSize(entry.downloadBytes), ''));
            if (entry.tier === 'essential') tags.appendChild(tag('Essential', 'essential'));
            if (entry.category) tags.appendChild(tag(entry.category, ''));
            if (requiredBy.has(entry.id)) {
                tags.appendChild(tag('Required by ' + requiredBy.get(entry.id).map(idOf).join(', '), 'req'));
            }
            if (installed) tags.appendChild(tag('Installed', 'ok'));
            else if (entry.bundled) tags.appendChild(tag('Included with the app', 'ok'));
            meta.appendChild(tags);

            row.appendChild(box);
            row.appendChild(meta);
            list.appendChild(row);
        }

        const dropped = (plan.conflicts || []).filter(c => c.dropped);
        $('review-note').textContent = dropped.length
            ? 'Not selected: ' + dropped.map(c => `${idOf(c.dropped)} conflicts with ${c.kept ? idOf(c.kept) : 'another required plugin'}`).join('; ') + '.'
            : '';
        $('review-count').textContent = String(plan.ids.length);
        $('review-size').textContent = formatSize(plan.downloadBytes);
        refreshPrimary();
    }

    function dependentsOf(id) {
        const dependents = [];
        for (const [dependent, deps] of Object.entries(plan.required || {})) {
            if (deps.includes(id)) dependents.push(dependent);
        }
        return dependents;
    }

    function idOf(id) {
        const entry = entryOf(id);
        return entry ? entry.name : id;
    }

    // Re-resolve in main so dependencies and conflicts update the moment a
    // checkbox changes.
    async function resolveAndRender() {
        const resolved = await api.pluginWizard.resolve([...checked]);
        plan = resolved.plan;
        // Adopt the resolved set: auto-added dependencies become checked, and
        // anything the resolver dropped (conflict, or a prerequisite that went
        // away) leaves the selection — the two views can never disagree.
        checked = new Set(plan.ids);
        renderReview();
    }

    // ── install ───────────────────────────────────────────────────────────

    const progress = new Map(); // id -> {received, total, phase, message}

    function onProgress(event) {
        const row = progress.get(event.id) || { received: 0, total: 0, phase: '', message: '' };
        row.phase = event.phase;
        if (event.phase === 'download') {
            row.received = event.receivedBytes || 0;
            row.total = event.totalBytes || 0;
        }
        if (event.phase === 'start') { row.received = 0; row.total = event.totalBytes || 0; }
        progress.set(event.id, row);
        renderProgress();
    }

    function renderProgress() {
        const list = $('progress-list');
        list.innerHTML = '';
        let received = 0;
        let total = 0;
        for (const id of plan.ids) {
            const entry = entryOf(id);
            const row = progress.get(id);
            const status = row || {};
            if (status.total) { received += status.received; total += status.total; }
            else if (needsDownload(entry)) { total += entry.downloadBytes; }
            if (!row && entry && entry.installedVersion === entry.version) continue;
            const div = document.createElement('div');
            div.className = 'row';
            const meta = document.createElement('div');
            meta.className = 'meta';
            const name = document.createElement('div');
            name.className = 'name';
            name.textContent = entry ? entry.name : id;
            meta.appendChild(name);
            const tags = document.createElement('div');
            tags.className = 'tags';
            if (status.phase === 'download' || status.phase === 'start') {
                tags.appendChild(tag('downloading…', 'busy'));
            } else if (status.phase === 'installed') {
                tags.appendChild(tag('installed', 'ok'));
            } else if (status.phase === 'failed') {
                tags.appendChild(tag('failed', 'bad'));
            } else if (status.phase === 'cancelled') {
                tags.appendChild(tag('cancelled', ''));
            } else if (entry && entry.installedVersion === entry.version) {
                tags.appendChild(tag('already installed', 'ok'));
            } else {
                tags.appendChild(tag('waiting', ''));
            }
            meta.appendChild(tags);
            div.appendChild(meta);
            list.appendChild(div);
        }
        const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
        $('progress-bar').value = percent;
    }

    async function install() {
        installing = true;
        progress.clear();
        showStep('progress');
        $('btn-cancel').disabled = false;
        refreshPrimary();
        renderProgress();

        const result = await api.pluginWizard.install(plan.ids);
        installing = false;
        const results = Array.isArray(result.results) ? result.results : [];
        const failed = results.filter(r => !r.success);

        // An empty result set means the batch never ran — main declined it
        // because another installation held the lock — so the refusal message
        // below must not be announced as a finished setup.
        let title = 'All set';
        if (failed.length) title = 'Setup finished with problems';
        else if (results.length === 0 && result.success === false) title = 'Nothing was installed';
        // A run that was not refused walks the bar to 100% on its own now that
        // the denominator matches the transfer; a refused or cancelled one must
        // not be painted as a complete one.
        if (result.success !== false) $('progress-bar').value = 100;
        $('done-title').textContent = title;
        $('done-line').textContent = result.message || '';
        const doneList = $('done-list');
        doneList.innerHTML = '';
        for (const item of failed) {
            const li = document.createElement('li');
            li.textContent = `${item.name || item.id}: ${item.message || 'could not be installed'}`;
            doneList.appendChild(li);
        }
        if (failed.length) {
            const note = document.createElement('li');
            note.textContent = 'You can retry these from the Plugin Manager — the rest of the app works as it is.';
            doneList.appendChild(note);
        }
        showStep('done');
    }

    // ── navigation ────────────────────────────────────────────────────────

    async function goToQuestions() {
        const preview = await api.pluginWizard.preview(answers);
        checked = new Set(preview.recommended);
        await resolveAndRender();
        showStep('review');
    }

    async function finish(skipped) {
        await api.pluginWizard.finish({ skipped });
    }

    $('btn-primary').addEventListener('click', async () => {
        const primary = $('btn-primary');
        primary.disabled = true;
        try {
            if (step === 'welcome') {
                showStep('questions');
            } else if (step === 'questions') {
                await goToQuestions();
            } else if (step === 'review') {
                if (!plan || plan.ids.length === 0) {
                    await finish(true);
                    return;
                }
                await install();
            } else if (step === 'done') {
                await finish(false);
            }
        } finally {
            refreshPrimary();
        }
    });

    $('btn-back').addEventListener('click', () => {
        if (step === 'review') showStep('questions');
        else if (step === 'questions') showStep('welcome');
    });

    $('btn-skip').addEventListener('click', () => { void finish(true); });

    $('btn-cancel').addEventListener('click', async () => {
        $('btn-cancel').disabled = true;
        $('progress-line').textContent = 'Cancelling — already-installed plugins stay installed.';
        await api.plugins.cancelCatalogInstall();
    });

    // ── start ─────────────────────────────────────────────────────────────

    (async function start() {
        try {
            state = await api.pluginWizard.getState();
            entries = Array.isArray(state.entries) ? state.entries : [];
            entriesById = new Map(entries.map(e => [e.id, e]));
        } catch (e) {
            $('review-note').textContent = 'The plugin catalog could not be read: ' + (e && e.message);
            return;
        }

        const unsubscribe = api.plugins.onInstallProgress(onProgress);

        if (!entries.length) {
            showStep('welcome');
            $('btn-primary').textContent = 'Continue into fee[dB]ack';
            $('btn-primary').addEventListener('click', () => { void finish(true); });
            return;
        }

        if (state.resume && state.selection.length) {
            // Interrupted run: pick up exactly where it stopped.
            checked = new Set(state.selection);
            await resolveAndRender();
            showStep('review');
            return;
        }
        if (!state.firstRun) {
            // Reopened from the Plugin Manager — go straight to the list.
            checked = new Set(state.recommended);
            await resolveAndRender();
            showStep('review');
            return;
        }
        renderQuestions();
        showStep('welcome');
        void unsubscribe;
    })();
})();
