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
  return { id, installDir: 'example_plugin', name: 'Example', description: 'Example plugin', repository: 'https://github.com/get-flashbacks/example', commit: 'a'.repeat(40), archiveSha256: 'b'.repeat(64), source: 'get-flashbacks', category: 'practice', instruments: ['guitar'], stability: 'stable', compatibility: { minCoreVersion: '1.0.0', minPluginApiVersion: '1' }, dependencies: [], conflicts: [], size: { downloadBytes: 1, installedBytes: 1 }, selection: { tier: 'optional', defaultSelected: false } };
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
