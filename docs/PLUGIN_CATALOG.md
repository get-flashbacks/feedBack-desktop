# Plugin catalog maintenance

The desktop ships an offline catalog snapshot in
`resources/plugin-catalog.json`. Curated entries are immutable: each one pins
an exact commit and the SHA-256 of GitHub's archive for that commit. This makes
the plugin set offered by a desktop release reproducible.

The catalog is the recommended, reviewed tier. It is not intended to hide the
rest of the `get-flashbacks` organization: the catalog UI will also expose a
runtime org index of repositories whose default branch contains a valid root
`plugin.json`. Those live entries must be labeled unreviewed/unpinned and use
the same secure installer as curated entries. A network or GitHub failure must
leave the bundled curated snapshot usable offline.

## Add or update a curated entry

1. Select a reviewed plugin commit; never use a moving branch name.
2. Download `https://codeload.github.com/OWNER/REPO/zip/COMMIT`.
3. Record its byte length and SHA-256, plus the extracted size.
4. Copy the manifest ID and version exactly. `installDir` must be a single
   Python-safe directory name and normally matches the manifest ID.
5. Declare only hard runtime dependencies. Recommendations belong in the UI,
   not in `dependencies`.
6. Run `npm run catalog:validate`, `npm run catalog:verify-remote`, and
   `npm run catalog:lock`.
7. Commit the catalog and regenerated lock together.

Removing an entry stops offering it to new users; it does not uninstall an
existing copy. A withdrawn or unsafe plugin should eventually be represented
by lifecycle metadata so clients can explain and disable it rather than
silently deleting user files (tracked in issue #6).

## Source and stability fields

- `get-flashbacks`: maintained in the organization.
- `upstream-official`: maintained by the upstream feedBack project.
- `reviewed-community`: third-party code explicitly reviewed for the catalog.

`stable`, `beta`, and `experimental` describe catalog confidence, not merely
the plugin's semantic-version major number.

## Release record

`resources/plugin-catalog.lock.json` is deterministic and contains the desktop
version, catalog digest, and exact plugin pins. The release build regenerates
it before packaging, and CI rejects a stale committed lock. It is included as
an application resource so a distributed build can be audited later.

## Installing from the catalog (no Git)

`src/main/plugin-installer.ts` installs catalog entries in the Electron main
process; `src/main/plugin-archive.ts` is its dependency-free ZIP reader. The
renderer reaches it through `window.feedBackDesktop.plugins`:

- `catalog()` — catalog entries plus `installedVersion`, `bundled`, and
  `canRollback` for each.
- `installCatalog(ids)` — install a batch by catalog id.
- `rollbackCatalog(id)` — restore the version kept in the backup slot.

The renderer passes ids only. The main process looks each id up in the
bundled catalog and builds the one URL it will download:
`https://codeload.github.com/OWNER/REPO/zip/COMMIT`.

### Validation

1. **Source.** The entry must be well formed. `get-flashbacks` entries must
   live under the `get-flashbacks` GitHub owner and `upstream-official`
   entries under `got-feedBack`. The download must be HTTPS and must end on
   `codeload.github.com`, including after redirects.
2. **Download.** The download is streamed and cut off as soon as it passes
   `size.downloadBytes`. It must then match that size exactly and match
   `archiveSha256`.
3. **Archive.** The ZIP must be the pinned commit: a single
   `<repo>-<commit>/` root directory, the commit SHA in the ZIP comment, and
   exactly `size.installedBytes` once uncompressed. The reader rejects:
   - absolute paths, drive letters, backslashes, and `.`/`..` segments;
   - empty path segments and names that are unsafe on Windows;
   - symlinks and special files;
   - case-insensitive duplicate names and overlapping records;
   - encrypted, ZIP64, and multi-volume archives;
   - CRC mismatches and entries whose size field is wrong.
   Every inflate is capped at the entry's declared size.
4. **Manifest.** The root `plugin.json` must parse and must carry the entry's
   `id` and `version`. It is checked again after extraction.

### Transaction

- **Staging.** The archive is extracted into
  `<userData>/plugins/.feedback-staging/` on the same filesystem as the live
  plugin. Files are created exclusively and no link is ever created. A
  failed download or extraction removes the staging directory and leaves the
  live copy alone. Staging left behind by a crash is removed at startup.
- **Destination.** The destination is `installDir`, resolved with the same
  single-segment rules as the git paths. Installation is refused when that
  slot is:
  - a symlink (a development checkout);
  - a file;
  - a directory whose `plugin.json` belongs to another plugin.
- **Activation.** The previous version is renamed into
  `.feedback-backups/<installDir>` and the staged tree is renamed into place.
  If the second rename fails, the previous version is renamed back. Renames
  retry on transient Windows `EPERM`/`EBUSY`. The reported message only claims
  the previous version was kept when it demonstrably survived: either the
  restore landed, or the backup slot still holds a copy that
  `rollbackCatalog` can put back.
- **Batches.** Each plugin is installed on its own, so one failure never
  affects the others. After all disk work, the backend restarts **once**.
  `/api/plugins` is then polled until each new plugin leaves `installing`.
  A probe that does not answer (socket error, timeout, or a body that is not
  the documented array) is retried and never counts as a load failure for any
  plugin. A plugin missing from an answer that did arrive stays pending for a
  grace window, so a plugin enumerated a poll or two late is not rolled back.
  - If a plugin reaches `ready` or `disabled` at the expected version, its
    backup is deleted.
  - If a plugin is `failed`, still missing after the grace window, or at the
    wrong version, its backup is restored (or the new install is removed if
    there was no previous version). The backend then restarts one more time.
  - If the 10-minute deadline passes while a plugin is still installing
    dependencies, the outcome is **unconfirmed**: reported as such, and the
    backup is kept rather than deleted. The next install of the same id, or an
    explicit `rollbackCatalog`, resolves it.
- **Unconfirmed installs.** If a second update arrives before the first is
  confirmed, the existing backup is kept as the last known-good version.
- **User data.** Plugin settings and data live in the config directory and
  browser storage, not in the plugin's source directory, so a source update
  never touches them. Removing a plugin also drops its backup, so the backup
  can never be "restored" over a later fresh install.
- **Dependencies.** Dependencies install before the plugins that declare them,
  so ordering in the request does not matter. A dependency is satisfied only by
  a copy that is already installed or that actually landed during this batch;
  one that failed to install refuses its dependents too.
- **Conflicts.** A plugin is refused if a declared conflict is already installed
  or was installed earlier in the same batch. A conflict is fatal only for the
  entry that would come second, so requesting a conflicting pair installs the
  first and explains the second. Conflicts may be declared one-sidedly — `x`
  conflicting with `y` is enough, and either order of the request obeys it.

### User copies vs. bundled plugins

The backend scans the user plugins dir before the packaged core plugins dir.
A user copy therefore overrides a packaged plugin with the same id. The
exception is a core plugin that sits in a directory named after its id and
has `"bundled": true` in its manifest; that copy always wins (see core's
`_is_bundled`). The installer reads the packaged core plugins dir and refuses
to install over those ids, because the installed copy would be silently
ignored. The packaged application itself is never modified.

The legacy `plugins:install` / `plugins:update` git paths remain for
developer-supplied repository URLs. They still require Git.

## Installed-state record

`src/main/plugin-installed-state.ts` persists what is installed for the plugin
lifecycle (issue #20, lifecycle 1/6 of #6). It writes
`<userData>/installed-plugins.json` — the desktop's own state dir, not the
plugins dir, because the record is desktop-owned state *about* that dir and the
backend scans the plugins dir for plugins.

One record per installed optional plugin, every field required:

| Field | Meaning |
| --- | --- |
| `id` | catalog plugin id |
| `installDir` | directory name under the plugins dir holding this copy |
| `version` | plugin version, as pinned by the catalog |
| `repository` | source repository the copy came from |
| `commit` | commit the archive was resolved to |
| `archiveSha256` | SHA-256 of the installed archive |
| `installedAt` | ISO-8601 UTC install time (`Date#toISOString`) |
| `catalogRevision` | catalog revision the entry was resolved from (the release lock's `catalogSha256`) |

The file is `{"schemaVersion": 1, "updatedAt": …, "plugins": {<id>: <record>}}`.
Field patterns are shared with the installer (`isPluginId`, `isCommitSha`, … in
`plugin-installer.ts`) so the record and the catalog gate cannot drift apart.
One plugin per `id`, one directory per plugin: a write refuses a duplicate.

Behaviour that later lifecycle features depend on:

- **Reads never throw.** A missing, unreadable, oversized, truncated or
  foreign-schema record yields an empty map plus an `issue` (`missing`,
  `unreadable`, `corrupt`, `unsupported-schema`), which reads as *bundled
  baseline only* — the plugins dir stays authoritative. Individual records that
  fail validation are dropped, so one damaged entry cannot hide the rest.
- **A newer record is never overwritten.** A schema version above the one this
  app writes is reported as `unsupported-schema` and `writeInstalledState`
  refuses, so a downgrade cannot destroy provenance it does not understand.
  There is no schema below v1 yet; that is where a migration goes.
- **Writes are atomic.** The body is written to `installed-plugins.json.tmp`
  (created exclusively, so a symlink planted there is replaced rather than
  followed), flushed, and renamed over the record, so a crash mid-write leaves
  either the previous record or the new one. A leftover `.tmp` is ignored by
  readers and replaced by the next write. A write that cannot complete throws
  rather than silently dropping provenance.
- **The operations that change the record are lifecycle 2/6** (update, pin,
  downgrade, disable, uninstall), with precedence in 3/6 and rollback in 4/6.
  Nothing writes the record until then. Three things 2/6 must settle: deleting an
  installed plugin has to drop or reconcile its record, the opt-in "also delete
  installed plugins" reset (`config-paths.ts`) removes only `pluginsDir`, so it has
  to remove the record too or a full opt-in reset would leave a record claiming
  plugins that are gone, and its writers must be serialized — a write re-reads the
  record to check the schema and then replaces it wholesale, so two concurrent
  read-modify-write callers would drop each other's entries.
