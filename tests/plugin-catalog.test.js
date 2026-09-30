'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');
const { validateCatalog } = require('../scripts/validate-plugin-catalog');

const root = path.join(__dirname, '..');
const validator = path.join(root, 'scripts', 'validate-plugin-catalog.js');
const catalogPath = path.join(root, 'resources', 'plugin-catalog.json');

function validEntry(id = 'example') {
  return { id, installDir: `${id}_plugin`, name: 'Example', description: 'Example plugin', repository: 'https://github.com/get-flashbacks/example', version: '1.2.3', commit: 'a'.repeat(40), archiveSha256: 'b'.repeat(64), source: 'get-flashbacks', category: 'practice', instruments: ['guitar'], stability: 'stable', compatibility: { minCoreVersion: '1.0.0', minPluginApiVersion: '1' }, dependencies: [], conflicts: [], size: { downloadBytes: 1, installedBytes: 1 }, selection: { tier: 'optional', defaultSelected: false } };
}

test('bundled plugin catalog validates', () => {
  const result = spawnSync(process.execPath, [validator, catalogPath], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
});

test('catalog validation rejects invalid IDs, duplicate IDs, missing refs, and bad dependencies', () => {
  const entry = validEntry('valid');
  entry.installDir = 'not-python-safe';
  entry.commit = 'main';
  entry.dependencies = ['missing'];
  const errors = validateCatalog({ schemaVersion: 1, entries: [entry, validEntry('valid')] });
  assert(errors.some(error => error.includes('Python-safe')));
  assert(errors.some(error => error.includes('immutable')));
  assert(errors.some(error => error.includes('duplicates valid')));
  assert(errors.some(error => error.includes('unknown plugin missing')));
});

test('catalog validation enforces nested schema fields and rejects dependency cycles', () => {
  const first = validEntry('first');
  const second = validEntry('second');
  first.dependencies = ['second'];
  second.dependencies = ['first'];
  first.selection = { tier: 'hidden', defaultSelected: true, surprise: true };
  first.size.downloadBytes = -1;
  first.source = 'unknown';
  const errors = validateCatalog({ schemaVersion: 1, entries: [first, second], surprise: true });
  assert(errors.some(error => error.includes('catalog.surprise is not allowed')));
  assert(errors.some(error => error.includes('source is invalid')));
  assert(errors.some(error => error.includes('downloadBytes must be a nonnegative integer')));
  assert(errors.some(error => error.includes('selection.surprise is not allowed')));
  assert(errors.some(error => error.includes('cannot default-select a hidden plugin')));
  assert(errors.some(error => error.includes('dependency cycle')));
});

test('catalog validation accepts prerelease versions and rejects malformed ones', () => {
  const entry = validEntry('example');
  entry.version = '1.2.3-beta.1';
  assert.deepStrictEqual(validateCatalog({ schemaVersion: 1, entries: [entry] }), []);
  entry.version = '1.2.3-';
  assert(validateCatalog({ schemaVersion: 1, entries: [entry] }).some(error => error.includes('version must be semver-like')));
});
