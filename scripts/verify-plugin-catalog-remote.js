#!/usr/bin/env node
'use strict';

// Verify that every immutable catalog pin still resolves to the expected
// manifest and archive. This deliberately uses raw/codeload URLs rather than
// the rate-limited GitHub API, so public catalog CI needs no token.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { validateCatalog } = require('./validate-plugin-catalog');

const catalogPath = path.join(__dirname, '..', 'resources', 'plugin-catalog.json');
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const localErrors = validateCatalog(catalog);
if (localErrors.length) {
  for (const error of localErrors) console.error(`- ${error}`);
  process.exit(1);
}

function repositoryParts(repository) {
  const url = new URL(repository);
  const [owner, repo] = url.pathname.slice(1).split('/');
  return { owner, repo };
}

async function fetchOk(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} fetching ${url}`);
  return response;
}

async function verifyEntry(entry) {
  const { owner, repo } = repositoryParts(entry.repository);
  const manifestUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${entry.commit}/plugin.json`;
  const manifest = await (await fetchOk(manifestUrl)).json();
  if (manifest.id !== entry.id) throw new Error(`manifest id ${manifest.id} does not match ${entry.id}`);
  if (manifest.version !== entry.version) throw new Error(`manifest version ${manifest.version} does not match ${entry.version}`);

  const archiveUrl = `https://codeload.github.com/${owner}/${repo}/zip/${entry.commit}`;
  const response = await fetchOk(archiveUrl);
  const digest = crypto.createHash('sha256');
  let bytes = 0;
  for await (const chunk of response.body) {
    digest.update(chunk);
    bytes += chunk.length;
  }
  const sha256 = digest.digest('hex');
  if (sha256 !== entry.archiveSha256) throw new Error(`archive SHA-256 ${sha256} does not match ${entry.archiveSha256}`);
  if (bytes !== entry.size.downloadBytes) throw new Error(`archive size ${bytes} does not match ${entry.size.downloadBytes}`);
  return `${entry.id}@${entry.version} (${entry.commit.slice(0, 12)})`;
}

(async () => {
  const failures = [];
  for (const entry of catalog.entries) {
    try {
      console.log(`Verified ${await verifyEntry(entry)}`);
    } catch (error) {
      failures.push(`${entry.id}: ${error.message}`);
    }
  }
  if (failures.length) {
    console.error('Remote plugin catalog verification failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  }
})();
