#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const catalogPath = path.join(root, 'resources', 'plugin-catalog.json');
const lockPath = path.join(root, 'resources', 'plugin-catalog.lock.json');
const packagePath = path.join(root, 'package.json');
const checkOnly = process.argv.includes('--check');
const catalogBytes = fs.readFileSync(catalogPath);
const catalog = JSON.parse(catalogBytes.toString('utf8'));
const desktop = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

const lock = {
  schemaVersion: 1,
  desktopVersion: desktop.version,
  catalogSha256: crypto.createHash('sha256').update(catalogBytes).digest('hex'),
  plugins: catalog.entries.map(entry => ({
    id: entry.id,
    version: entry.version,
    repository: entry.repository,
    commit: entry.commit,
    archiveSha256: entry.archiveSha256,
  })),
};
const rendered = `${JSON.stringify(lock, null, 2)}\n`;

if (checkOnly) {
  const current = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : '';
  if (current !== rendered) {
    console.error('resources/plugin-catalog.lock.json is stale; run npm run catalog:lock');
    process.exitCode = 1;
  } else {
    console.log(`Plugin catalog lock is current (${lock.plugins.length} plugins).`);
  }
} else {
  fs.writeFileSync(lockPath, rendered);
  console.log(`Wrote ${lockPath} (${lock.plugins.length} plugins).`);
}
