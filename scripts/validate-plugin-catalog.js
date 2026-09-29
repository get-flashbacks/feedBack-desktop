#!/usr/bin/env node
'use strict';

// Lightweight, dependency-free validation for the bundled catalog. The JSON
// Schema remains the interchange contract; this script enforces the
// cross-entry invariants that JSON Schema cannot express by itself.
const fs = require('fs');
const path = require('path');

// eslint-disable-next-line security/detect-non-literal-fs-filename -- built entirely from
// literal segments (__dirname + fixed names), never from user/catalog input
const catalogPath = path.join(__dirname, '..', 'resources', 'plugin-catalog.json');
const schemaPath = path.join(__dirname, '..', 'resources', 'plugin-catalog.schema.json');
// eslint-disable-next-line security/detect-non-literal-fs-filename -- see above
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const entrySchema = schema.$defs.entry;

// Precompiled as RegExp literals (not built from a runtime string) so no call
// site constructs a RegExp from a non-literal argument. `matches` takes the
// compiled RegExp directly.
const ID_PATTERN = /^[a-z][a-z0-9_-]*$/;
const INSTALL_DIR_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REPOSITORY_PATTERN = /^https:\/\/github\.com\/[^/]+\/[^/]+$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const ARCHIVE_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const SOURCES = new Set(['get-flashbacks', 'upstream-official', 'reviewed-community']);
const STABILITIES = new Set(['stable', 'beta', 'experimental']);
const TIERS = new Set(['essential', 'recommended', 'optional', 'hidden']);
const TOP_LEVEL_KEYS = new Set(Object.keys(schema.properties));
const ENTRY_KEYS = new Set(Object.keys(entrySchema.properties));
const COMPATIBILITY_KEYS = new Set(Object.keys(entrySchema.properties.compatibility.properties));
const SIZE_KEYS = new Set(Object.keys(entrySchema.properties.size.properties));
const SELECTION_KEYS = new Set(Object.keys(entrySchema.properties.selection.properties));

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unknownKeys(value, allowed) {
  return isObject(value) ? Object.keys(value).filter(key => !allowed.has(key)) : [];
}

function isUniqueStringArray(value) {
  return Array.isArray(value)
    && value.every(item => typeof item === 'string' && item.length > 0)
    && new Set(value).size === value.length;
}

function validateCatalog(catalog) {
  const errors = [];
  const fail = message => errors.push(message);
  const matches = (value, regex) => typeof value === 'string' && regex.test(value);
  if (!isObject(catalog)) return ['catalog must be an object'];
  for (const key of unknownKeys(catalog, TOP_LEVEL_KEYS)) fail(`catalog.${key} is not allowed`);
  if (catalog.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (!Array.isArray(catalog.entries)) fail('entries must be an array');
  if (catalog.generatedAt !== undefined && Number.isNaN(Date.parse(catalog.generatedAt))) {
    fail('generatedAt must be an RFC 3339 date-time');
  }
  const required = entrySchema.required;
  const ids = new Set();
  const dirs = new Set();
  for (const [index, entry] of (catalog.entries || []).entries()) {
  const label = `entries[${index}]`;
  if (!isObject(entry)) { fail(`${label} must be an object`); continue; }
  for (const key of required) if (!(key in entry)) fail(`${label}.${key} is required`);
  for (const key of unknownKeys(entry, ENTRY_KEYS)) fail(`${label}.${key} is not allowed`);
  if (!matches(entry.id, ID_PATTERN)) fail(`${label}.id is invalid`);
  if (!matches(entry.installDir, INSTALL_DIR_PATTERN)) fail(`${label}.installDir must be Python-safe`);
  if (typeof entry.name !== 'string' || !entry.name.trim()) fail(`${label}.name must be non-empty`);
  if (typeof entry.description !== 'string' || !entry.description.trim()) fail(`${label}.description must be non-empty`);
  if (!matches(entry.repository, REPOSITORY_PATTERN)) fail(`${label}.repository must be a GitHub repository URL`);
  if (!matches(entry.version, VERSION_PATTERN)) fail(`${label}.version must be semver-like`);
  if (!matches(entry.commit, COMMIT_PATTERN)) fail(`${label}.commit must be an immutable 40-character SHA`);
  if (!matches(entry.archiveSha256, ARCHIVE_SHA256_PATTERN)) fail(`${label}.archiveSha256 must be a SHA-256 hex digest`);
  if (!SOURCES.has(entry.source)) fail(`${label}.source is invalid`);
  if (typeof entry.category !== 'string' || !entry.category.trim()) fail(`${label}.category must be non-empty`);
  if (!isUniqueStringArray(entry.instruments)) fail(`${label}.instruments must contain unique non-empty strings`);
  if (!STABILITIES.has(entry.stability)) fail(`${label}.stability is invalid`);
  if (!isUniqueStringArray(entry.dependencies)) fail(`${label}.dependencies must contain unique non-empty strings`);
  if (!isUniqueStringArray(entry.conflicts)) fail(`${label}.conflicts must contain unique non-empty strings`);

  if (!isObject(entry.compatibility)) {
    fail(`${label}.compatibility must be an object`);
  } else {
    for (const key of unknownKeys(entry.compatibility, COMPATIBILITY_KEYS)) fail(`${label}.compatibility.${key} is not allowed`);
    for (const key of ['minCoreVersion', 'minPluginApiVersion']) {
      if (typeof entry.compatibility[key] !== 'string' || !entry.compatibility[key]) fail(`${label}.compatibility.${key} is required`);
    }
    for (const key of ['maxCoreVersion', 'maxPluginApiVersion']) {
      if (entry.compatibility[key] !== undefined && (typeof entry.compatibility[key] !== 'string' || !entry.compatibility[key])) {
        fail(`${label}.compatibility.${key} must be non-empty when present`);
      }
    }
  }

  if (!isObject(entry.size)) {
    fail(`${label}.size must be an object`);
  } else {
    for (const key of unknownKeys(entry.size, SIZE_KEYS)) fail(`${label}.size.${key} is not allowed`);
    for (const key of ['downloadBytes', 'installedBytes']) {
      if (!Number.isInteger(entry.size[key]) || entry.size[key] < 0) fail(`${label}.size.${key} must be a nonnegative integer`);
    }
  }

  if (!isObject(entry.selection)) {
    fail(`${label}.selection must be an object`);
  } else {
    for (const key of unknownKeys(entry.selection, SELECTION_KEYS)) fail(`${label}.selection.${key} is not allowed`);
    if (!TIERS.has(entry.selection.tier)) fail(`${label}.selection.tier is invalid`);
    if (typeof entry.selection.defaultSelected !== 'boolean') fail(`${label}.selection.defaultSelected must be boolean`);
    if (entry.selection.defaultSelected && entry.selection.tier === 'hidden') fail(`${label}.selection cannot default-select a hidden plugin`);
  }
  if (ids.has(entry.id)) fail(`${label}.id duplicates ${entry.id}`); ids.add(entry.id);
    if (dirs.has(entry.installDir)) fail(`${label}.installDir duplicates ${entry.installDir}`); dirs.add(entry.installDir);
  }

  for (const [index, entry] of (catalog.entries || []).entries()) {
  if (!entry || typeof entry !== 'object') continue;
  for (const dependency of [...(entry.dependencies || []), ...(entry.conflicts || [])]) {
    if (!ids.has(dependency)) fail(`entries[${index}] references unknown plugin ${dependency}`);
  }
  if ((entry.dependencies || []).includes(entry.id) || (entry.conflicts || []).includes(entry.id)) {
    fail(`entries[${index}] cannot depend on or conflict with itself`);
  }
  for (const dependency of entry.dependencies || []) {
    if ((entry.conflicts || []).includes(dependency)) fail(`entries[${index}] both depends on and conflicts with ${dependency}`);
  }
  }

  const byId = new Map((catalog.entries || []).filter(isObject).map(entry => [entry.id, entry]));
  const visiting = new Set();
  const visited = new Set();
  function visit(id, path = []) {
    if (visiting.has(id)) { fail(`dependency cycle: ${[...path, id].join(' -> ')}`); return; }
    if (visited.has(id) || !byId.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependencies || []) visit(dependency, [...path, id]);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of byId.keys()) visit(id);
  return errors;
}

if (require.main === module) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- see comment at catalogPath above
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const errors = validateCatalog(catalog);
  if (errors.length) {
    console.error(`Plugin catalog validation failed (${catalogPath}):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log(`Plugin catalog is valid (${catalog.entries.length} entries).`);
  }
}

module.exports = { validateCatalog };
