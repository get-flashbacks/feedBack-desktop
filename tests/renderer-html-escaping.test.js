// Issue #29: the Plugin Manager's git-installed list built its rows with
// innerHTML and interpolated the cloned repository's plugin.json `name` and
// `description` — and its own error string — straight into the template. The
// renderer windows run with webSecurity:false, so there is no CSP to make a
// stray `<` inert: a repository that shipped
//   "description": "<img src=x onerror=...>"
// executed in the app the moment the list was drawn.
//
// The rows are built from nodes and textContent instead, so there is nothing to
// escape and this suite pins that: the hostile string must arrive intact as
// text, no element in the row may carry markup, and the update/remove buttons
// must still carry the exact plugin name so a quote in it cannot truncate the
// attribute either.
//
// The same sweep applies to the audio screen's two list rows, which read names
// off disk (a VST bundle is just a directory name).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const PM_SCREEN_JS = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'plugin-manager', 'screen.js'), 'utf8');
const AUDIO_SCREEN_JS = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'screen.js'), 'utf8');

const HOSTILE = '<img src=x onerror="alert(1)">';
// A name that would break out of a double-quoted attribute if it were still
// interpolated into one.
const HOSTILE_NAME = '" onmouseover="alert(1)';

// ── Minimal DOM stub ──────────────────────────────────────────────────────
// Enough of the element API for these render paths: an innerHTML assignment
// replaces the children, as the DOM does, and class-selector queries walk the
// tree. No parsing happens, which is the point: the assertions read back what
// the screen handed to the DOM, not what a browser would build from it.

function makeElement(tag = 'div') {
    const el = {
        tagName: String(tag).toUpperCase(),
        className: '',
        textContent: '',
        id: '',
        type: '',
        value: '',
        disabled: false,
        checked: false,
        dataset: {},
        children: [],
        handlers: {},
        style: {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        appendChild(child) { el.children.push(child); return child; },
        addEventListener(type, fn) { (el.handlers[type] = el.handlers[type] || []).push(fn); },
    };

    let html = '';
    Object.defineProperty(el, 'innerHTML', {
        get() { return html; },
        set(value) { html = String(value); el.children.length = 0; },
    });

    el.querySelectorAll = (selector) => descendants(el).filter((node) => matchesClass(node, selector));
    el.querySelector = (selector) => el.querySelectorAll(selector)[0] || null;
    return el;
}

function descendants(el, found = []) {
    for (const child of el.children) {
        found.push(child);
        descendants(child, found);
    }
    return found;
}

// Only the `.class` selector form these screens use.
function matchesClass(node, selector) {
    if (!selector.startsWith('.')) throw new Error(`stub query does not handle '${selector}'`);
    return String(node.className).split(/\s+/).includes(selector.slice(1));
}

function makeDocument() {
    const byId = new Map();
    return {
        byId,
        getElementById(id) {
            if (!byId.has(id)) byId.set(id, makeElement());
            return byId.get(id);
        },
        createElement: (tag) => makeElement(tag),
    };
}

// Every non-empty innerHTML string anywhere in the subtree. These rows are
// built from nodes, so a non-empty entry means some part of the row handed the
// browser a markup string — the regression this suite exists for.
function markupStrings(el, found = []) {
    if (el.innerHTML) found.push(el.innerHTML);
    for (const child of el.children) markupStrings(child, found);
    return found;
}

// The screen script calls refreshList() at load without keeping the promise, so
// the harness drives it and drains the queue: once listInstalled resolves the
// rest of the render is synchronous.
const flush = () => new Promise((resolve) => setImmediate(resolve));

function runPluginManager({ installed = [], listError = null } = {}) {
    const document = makeDocument();
    const removed = [];
    const updated = [];
    const plugins = {
        listInstalled: () => (listError ? Promise.reject(listError) : Promise.resolve(installed)),
        // The screen calls refreshCatalog() on load as well; nothing to render.
        catalog: () => Promise.resolve([]),
        remove: async (name) => { removed.push(name); return { success: true, message: 'Removed.' }; },
        update: async (name) => { updated.push(name); return { success: true, message: 'Updated.' }; },
    };

    const sandbox = {
        window: { feedBackDesktop: { plugins } },
        document,
        setTimeout: () => 0,
        clearTimeout: () => {},
        confirm: () => true,
        globalThis: undefined,
    };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(PM_SCREEN_JS, sandbox, { filename: 'plugin-manager/screen.js' });

    return { list: document.getElementById('pm-list'), removed, updated };
}

// ── Plugin Manager: git-installed list ────────────────────────────────────

test('git-installed plugin metadata renders as text, never as markup', async () => {
    const { list } = runPluginManager({
        installed: [{
            name: HOSTILE_NAME,
            hasGit: true,
            version: '1.0.0',
            manifest: { name: HOSTILE, description: HOSTILE },
        }],
    });
    await flush();
    await flush();

    assert.equal(list.children.length, 1, 'one row per installed plugin');
    const [meta] = list.children[0].children;
    assert.equal(meta.children[0].textContent, HOSTILE, 'name lands as the literal string');
    assert.equal(meta.children[1].textContent, HOSTILE, 'description lands as the literal string');
    assert.equal(meta.children[2].textContent, 'v1.0.0', 'version is prefixed as before');

    const markup = markupStrings(list);
    assert.deepEqual(markup, [], `no part of the row may be built from markup, got:\n${markup.join('\n')}`);
});

test('update and remove buttons carry the plugin name verbatim, quotes and all', async () => {
    const { list, removed, updated } = runPluginManager({
        installed: [{ name: HOSTILE_NAME, hasGit: true, version: '1.0.0', manifest: {} }],
    });
    await flush();
    await flush();

    const update = list.querySelector('.pm-update');
    const remove = list.querySelector('.pm-remove');
    assert.ok(update && remove, 'a git-installed plugin offers both actions');
    assert.equal(update.dataset.name, HOSTILE_NAME, 'update targets the exact name');
    assert.equal(remove.dataset.name, HOSTILE_NAME, 'remove targets the exact name');

    await update.handlers.click[0]();
    assert.deepEqual(updated, [HOSTILE_NAME], 'the bridge receives the whole name');
    await remove.handlers.click[0]();
    assert.deepEqual(removed, [HOSTILE_NAME], 'and so does remove');
});

test('a failure from listInstalled renders as text, thrown or not', async () => {
    for (const thrown of [new Error(`${HOSTILE} while listing`), `${HOSTILE} while listing`]) {
        const { list } = runPluginManager({ listError: thrown });
        await flush();
        await flush();

        assert.equal(list.children.length, 1, 'the error replaces the list');
        assert.equal(list.children[0].textContent, `Error loading plugins: ${HOSTILE} while listing`);
        assert.deepEqual(markupStrings(list), [], 'the error string is not markup');
    }
});

test('the screen script parses whole — no duplicate top-level declaration', () => {
    assert.doesNotThrow(() => new vm.Script(PM_SCREEN_JS, { filename: 'plugin-manager/screen.js' }));
});

// ── Audio screen: the same pattern in its two list rows ───────────────────

// Brace-balanced extraction of `function NAME(...) { ... }`, skipping the
// parameter list first so a default value isn't mistaken for the body.
// `tail` names the function's closing statement: a body cut short would still be
// brace-balanced, and the "no markup" assertions below would pass it vacuously.
function extractFunction(src, name, tail) {
    const sig = `function ${name}(`;
    const fnStart = src.indexOf(sig);
    assert.ok(fnStart !== -1, `function '${name}' not found`);
    // Keep an `async` prefix: a lifted await is only legal inside an async function.
    const start = src.slice(Math.max(0, fnStart - 6), fnStart) === 'async ' ? fnStart - 6 : fnStart;
    let i = fnStart + sig.length;
    let parens = 1;
    while (i < src.length && parens > 0) {
        if (src[i] === '(') parens++;
        else if (src[i] === ')') parens--;
        i++;
    }
    assert.ok(parens === 0, `unbalanced parens in '${name}' signature`);
    let depth = 1;
    i = src.indexOf('{', i) + 1;
    while (i < src.length && depth > 0) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        i++;
    }
    assert.ok(depth === 0, `unbalanced braces in '${name}'`);
    const body = src.slice(start, i);
    assert.ok(body.includes(tail), `'${name}' extraction stopped short of '${tail}'`);
    return body;
}

test('the audio screen parses whole — no duplicate top-level declaration', () => {
    assert.doesNotThrow(() => new vm.Script(AUDIO_SCREEN_JS, { filename: 'screen.js' }));
});

test('the VST browser row escapes the scanned plugin name, manufacturer and format', () => {
    const document = makeDocument();
    const vstList = document.createElement('div');
    const sandbox = {
        document,
        vstList,
        knownPlugins: [{ name: HOSTILE, manufacturer: HOSTILE, format: '<b>VST3</b>' }],
    };
    vm.runInNewContext([
        extractFunction(AUDIO_SCREEN_JS, 'escHtml', "return String(value ?? '')"),
        extractFunction(AUDIO_SCREEN_JS, 'renderVSTList', 'vstList.appendChild(div);'),
        'globalThis.__renderVSTList = renderVSTList;',
    ].join('\n'), sandbox, { filename: 'vst-list.js' });
    sandbox.globalThis = sandbox;

    sandbox.__renderVSTList();

    assert.equal(vstList.children.length, 1, 'one row per scanned plugin');
    const html = vstList.children[0].innerHTML;
    assert.equal(html.includes('<img'), false, `name must not reach the DOM as markup, got:\n${html}`);
    assert.equal(html.includes('<b>'), false, 'format must not reach the DOM as markup either');
    // Escaped, not dropped: both strings still have to be on the row.
    assert.equal(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'), true, 'name escaped, not dropped');
    assert.equal(html.includes('&lt;b&gt;VST3&lt;/b&gt;'), true, 'format escaped, not dropped');
});

test('the signal chain row escapes the processor name', async () => {
    const document = makeDocument();
    const container = document.getElementById('ae-chain');
    const sandbox = {
        document,
        chainContainer: null,
        $: (id) => document.getElementById(id),
        api: {
            getChainState: async () => [
                { type: 1, id: 3, name: HOSTILE, bypassed: false, hasEditor: false },
            ],
        },
    };
    vm.runInNewContext([
        extractFunction(AUDIO_SCREEN_JS, 'escHtml', "return String(value ?? '')"),
        extractFunction(AUDIO_SCREEN_JS, 'aeIsRigBuilderStage', 'return false;'),
        extractFunction(AUDIO_SCREEN_JS, 'refreshChain', 'return chain;'),
        'globalThis.__refreshChain = refreshChain;',
    ].join('\n'), sandbox, { filename: 'signal-chain.js' });
    sandbox.globalThis = sandbox;

    await sandbox.__refreshChain();

    assert.equal(container.children.length, 1, 'one row per processor');
    const html = container.children[0].innerHTML;
    assert.equal(html.includes('<img'), false, `processor name must not reach the DOM as markup, got:\n${html}`);
    assert.equal(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'), true, 'escaped, not dropped');
    assert.equal(html.includes('_aeRemoveSlot(3)'), true, 'the row still wires its own slot id');
});