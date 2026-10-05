// Shared helper: compile a TypeScript module on the fly and load it as CommonJS,
// matching the transpile-on-load pattern used by the other node:test suites
// (see audio-effects-executor.test.js). Lets us unit-test the pure config-*.ts
// modules without a build step or an electron runtime.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');

// Compiler options come from tsconfig.json so this shim cannot drift from what
// `npm run typecheck` and `npm run build:ts` use.
const tsconfig = ts.readConfigFile(path.join(ROOT, 'tsconfig.json'), ts.sys.readFile);
if (tsconfig.error) throw new Error(ts.flattenDiagnosticMessageText(tsconfig.error.messageText, '\n'));
const compilerOptions = ts.parseJsonConfigFileContent(tsconfig.config, ts.sys, ROOT).options;

// Register the .ts loader once, so a module loaded through loadTs() can require
// another .ts module by its normal relative specifier (e.g. config-paths.ts
// importing the installed-state record's file name) instead of failing on an
// extensionless require that node cannot resolve on its own.
require.extensions['.ts'] = function compileTs(module, filename) {
    const source = fs.readFileSync(filename, 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions, fileName: filename });
    module._compile(outputText, filename);
};

function loadTs(relPath) {
    const file = path.join(ROOT, relPath);
    const source = fs.readFileSync(file, 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions,
        fileName: file,
    }).outputText;
    const mod = new Module(file, module);
    mod.filename = file;
    mod.paths = Module._nodeModulePaths(path.dirname(file));
    mod._compile(compiled, file);
    return mod.exports;
}

module.exports = { loadTs, ROOT };
