'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');
const root = path.join(__dirname, '..');
const validator = path.join(root, 'scripts', 'validate-plugin-catalog.js');
const catalogPath = path.join(root, 'resources', 'plugin-catalog.json');
function validate(catalog) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-catalog-'));
  const candidate = path.join(dir, 'catalog.json');
  fs.writeFileSync(candidate, JSON.stringify(catalog));
  const result = spawnSync(process.execPath, [validator, candidate], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}
function validEntry(id = 'example') {
  return { id, installDir: 'example_plugin', name: 'Example', description: 'Example plugin', repository: 'https://github.com/get-flashbacks/example', commit: 'a'.repeat(40), archiveSha256: 'b'.repeat(64), source: 'get-flashbacks', category: 'practice', instruments: ['guitar'], stability: 'stable', compatibility: { minCoreVersion: '1.0.0', minPluginApiVersion: '1' }, dependencies: [], conflicts: [], size: { downloadBytes: 1, installedBytes: 1 }, selection: { tier: 'optional', defaultSelected: false } };
}
test('bundled plugin catalog validates', () => {
  const result = spawnSync(process.execPath, [validator, catalogPath], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
});
test('catalog validation rejects invalid IDs, duplicate IDs, missing refs, and bad dependencies', () => {
  const entry = validEntry('valid');
  entry.installDir = 'not-python-safe'; entry.commit = 'main'; entry.dependencies = ['missing'];
  const result = validate({ schemaVersion: 1, entries: [entry, validEntry('valid')] });
  assert.notStrictEqual(result.status, 0);
});