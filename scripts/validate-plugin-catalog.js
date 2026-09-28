#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const catalogPath = process.argv[2] || path.join(__dirname, '..', 'resources', 'plugin-catalog.json');
const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'resources', 'plugin-catalog.schema.json'), 'utf8'));
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const errors = [];
const entrySchema = schema.$defs.entry;
const fail = message => errors.push(message);
const matches = (value, pattern) => typeof value === 'string' && new RegExp(pattern).test(value);
if (catalog.schemaVersion !== 1) fail('schemaVersion must be 1');
if (!Array.isArray(catalog.entries)) fail('entries must be an array');
const ids = new Set(), dirs = new Set();
for (const [index, entry] of (catalog.entries || []).entries()) {
  const label = `entries[${index}]`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { fail(`${label} must be an object`); continue; }
  for (const key of entrySchema.required) if (!(key in entry)) fail(`${label}.${key} is required`);
  if (!matches(entry.id, '^[a-z][a-z0-9_-]*$')) fail(`${label}.id is invalid`);
  if (!matches(entry.installDir, '^[A-Za-z_][A-Za-z0-9_]*$')) fail(`${label}.installDir must be Python-safe`);
  if (!matches(entry.repository, '^https://github\\.com/[^/]+/[^/]+$')) fail(`${label}.repository must be a GitHub repository URL`);
  if (!matches(entry.commit, '^[0-9a-f]{40}$')) fail(`${label}.commit must be an immutable 40-character SHA`);
  if (!matches(entry.archiveSha256, '^[0-9a-f]{64}$')) fail(`${label}.archiveSha256 must be a SHA-256 hex digest`);
  if (ids.has(entry.id)) fail(`${label}.id duplicates ${entry.id}`); ids.add(entry.id);
  if (dirs.has(entry.installDir)) fail(`${label}.installDir duplicates ${entry.installDir}`); dirs.add(entry.installDir);
}
for (const [index, entry] of (catalog.entries || []).entries()) {
  if (!entry || typeof entry !== 'object') continue;
  for (const dependency of [...(entry.dependencies || []), ...(entry.conflicts || [])]) if (!ids.has(dependency)) fail(`entries[${index}] references unknown plugin ${dependency}`);
  if ((entry.dependencies || []).includes(entry.id) || (entry.conflicts || []).includes(entry.id)) fail(`entries[${index}] cannot depend on or conflict with itself`);
}
if (errors.length) { console.error(`Plugin catalog validation failed (${catalogPath}):`); for (const error of errors) console.error(`- ${error}`); process.exitCode = 1; }
else console.log(`Plugin catalog is valid (${catalog.entries.length} entries).`);