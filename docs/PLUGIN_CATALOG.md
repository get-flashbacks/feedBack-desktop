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

- `catalog()` — `{ ok, entries, message? }`, where each entry carries
  `installedVersion` (the version of any user-installed copy, `null` when only
  the packaged copy exists), `bundled` (the packaged copy is a bundled
  baseline), `activeSource` (which copy the backend loads — `bundled`,
  `writable-override`, `installed`, or `none`), `canRollback`, `recoveryInstructions`
  (a human-readable recovery note the row renders when a rollback or downgrade
  path is available — see lifecycle 4/6 below), `compat`
  (the entry's declared `compatibility` bounds judged against this build by
  `src/main/plugin-compat.ts`: `{ ok, requirements, reason }`, where
  `requirements` is the display phrase for the bounds ("fee[dB]ack core 0.3.0
  or newer, plugin API 1 or newer") and a per-entry `compat.ok: false` with its
  `reason` says why the entry does not fit this build), and the lifecycle view
  of `src/main/plugin-lifecycle.ts` (`installed`, `enabled`, `pinned`,
  `updateStatus`, `updateAvailable`, `downgradeVersions`, `disabled`, `recoveryInstructions`) that the
  per-plugin controls render from. The top-level `ok: false` means the bundled
  catalog file is missing or unreadable, which the catalog view shows as an
  error rather than as an empty catalog.
- `resolveCatalog(ids)` — the resolved installation set for the current
  selection, before anything is downloaded: `{ ids, outstanding, required,
  conflicts, downloadBytes }`, where `ids` is the final set in install order
  (dependencies first), `required` names which entry pulled each dependency in,
  `conflicts` reports what the conflict pass pruned, and `downloadBytes` is the
  pinned transfer size of `outstanding`.
- `installCatalog(ids)` — install a batch by catalog id. Entries whose
  `compat` verdict is `ok: false` are refused (with that reason) before any
  download, as are copies the recorded state forbids touching (pinned,
  disabled, or behind the catalog). The answer is `{ success, message,
  results, networkRequired? }`; `networkRequired` is set when the failures are
  connectivity-shaped, so the UI reports "a connection is required" and keeps
  the selection for a retry instead of presenting a broken install.
- `rollbackCatalog(id)` — restore the version kept in the backup slot.
- `onInstallProgress(cb)` — progress ticks of the in-flight batch, broadcast to
  every window, so the setup wizard and this screen can drive the same bar.
- `cancelCatalogInstall()` — abort the running batch. Whatever already landed is
  still activated; the rest is simply not installed and can be re-selected.

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

`plugins:catalog` reports the resolution per entry as `activeSource`: the
packaged copy ("bundled"), a user copy shadowing a packaged one that did not
claim `bundled: true` ("writable-override"), a user copy with no packaged one
beneath it ("installed"), or nothing on disk ("none"). `bundled` still means
"the packaged copy is a bundled baseline" — the two fields answer different
questions, so a packaged non-baseline with no user copy reports
`bundled: false` with `activeSource: 'bundled'`. The rule lives in
`src/main/plugin-precedence.ts` (issue #22).

One deliberate divergence from the backend: when two directories in the same
root claim the same id (a hand-broken layout), the desktop resolves duplicates
by sorted directory name, which the backend's unsorted scan does not guarantee.
This only affects which copy's version `installedVersion` names; `activeSource`
distinguishes only between the core and user roots and is unaffected.

The legacy `plugins:install` / `plugins:update` git paths remain for
developer-supplied repository URLs. They still require Git.

## Installed-state record

`src/main/plugin-installed-state.ts` persists what is installed for the plugin
lifecycle (issue #20, lifecycle 1/6 of #6; schema v2 for 2/6). It writes
`<userData>/installed-plugins.json` — the desktop's own state dir, not the
plugins dir, because the record is desktop-owned state *about* that dir and the
backend scans the plugins dir for plugins.

One record per installed optional plugin. The provenance fields are always
required and validated:

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

Lifecycle 2/6 added the state the operations change, plus the three fields that
make a recorded version reinstallable (see "Pin and downgrade" below). `source`,
`downloadBytes` and `installedBytes` are optional as a group: they are what a
recorded pin needs to be re-verified, so a copy installed before schema v2 has
none of them and simply reports no downgrade target until its next update.

| Field | Meaning |
| --- | --- |
| `enabled` | `false` while the user has the plugin disabled but still installed |
| `pinned` | `true` while the user holds this version; updates are held |
| `previousVersions` | versions a downgrade may reinstall, newest first, capped at 10. Each entry is a `RecordedPin`: version, repository, commit, `archiveSha256`, `catalogRevision`, `source` and the archive sizes |
| `source` | catalog trust class (`get-flashbacks`, `upstream-official`, `reviewed-community`) |
| `downloadBytes`, `installedBytes` | archive sizes, re-checked when the archive is downloaded again |

The file is `{"schemaVersion": 2, "updatedAt": …, "plugins": {<id>: <record>}}`.
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
- **An older one is migrated, not rejected.** A v1 record is read as the same
  plugin with `enabled: true` and `pinned: false`; the migration happens in
  memory and is written back by the next write, so nothing is lost and a v1
  install is fully usable.
- **Writes are atomic.** The body is written to `installed-plugins.json.tmp`
  (created exclusively, so a symlink planted there is replaced rather than
  followed), flushed, and renamed over the record, so a crash mid-write leaves
  either the previous record or the new one. A leftover `.tmp` is ignored by
  readers and replaced by the next write. A write that cannot complete throws
  rather than silently dropping provenance.
- **Writers are serialized.** `updateInstalledState` runs every
  read-modify-write through one promise chain, because a write re-reads the
  record to check the schema and then replaces it wholesale: two concurrent
  callers would otherwise drop each other's entries. A mutator that throws
  leaves the file untouched.

## Plugin lifecycle operations (2/6)

Issue #21 adds the five operations that act on an installed plugin. The rules
are pure functions in `src/main/plugin-lifecycle.ts` — no electron, no
filesystem, no network — and `plugin-manager.ts` performs the disk work those
answers authorize. Every rule that could cost the user a working copy is a
refusal, so each is tested on its own (`tests/plugin-lifecycle.test.js`) rather
than only through the IPC surface.

| Operation | Rule |
| --- | --- |
| Update | The catalog carries one version per plugin, so an update installs the catalog's version over the installed one — and only when the record is not pinned and not disabled. A copy the catalog is *behind* is refused as well: that install is a downgrade, not an update. The digest is re-verified against the download, as for a fresh install. |
| Pin | Pins the version that is installed now, which is all a pin can mean. A pin holds updates and republish checks; changing version (by update or downgrade) drops it, because it described the version that was there before. Unpinning is always allowed. |
| Downgrade | Reinstalls a `previousVersions` pin — the same immutable archive the catalog pinned when that version was current — and re-verifies it against the digest recorded then. No renderer-supplied URL reaches the installer, and a pin that today's gate would refuse is refused rather than reinstalled unchecked. |
| Disable | Moves the copy to `<pluginsDir>/.feedback-disabled/<installDir>` and sets `enabled: false`. The backend's scan is one level deep and skips dot-prefixed names, so a parked copy is invisible to it. No download is involved. |
| Re-enable | Moves the same bytes back. Nothing is fetched or re-verified: the directory is the authority, so a parked copy is moved and a copy that is somehow live again is reported rather than replaced. |
| Uninstall | Removes the live, parked and backup copies, drops the record, and offers to delete the plugin's data as a separate, explicit choice. |

States are derived, not stored twice: a copy parked on disk is disabled whatever
the record says, because the directory is what the backend sees.

Notes that matter when changing any of this:

- **One refusal for every path that installs the catalog's version**
  (`installRefusal`), used by the per-plugin Update button and by the catalog
  list's batch selection alike. Ticking the box in the list is not a way around
  the button's rules: a pinned, disabled, up-to-date or `ahead` copy is refused
  per plugin, with the same message the button would give. `ahead` is the case
  that keeps its own `Downgrade` buttons, which reinstall a pin from the record.
- **A record that will not write does not undo an install that landed.** Once the
  backend has accepted a version its rollback backup is already gone, so a failed
  record write is logged and the outcome reported as what happened. The mirror
  case is reported rather than swallowed too: an uninstall whose record cannot be
  dropped says so, instead of leaving a row that claims a version with no files.
- **Disabling drops the backup.** The backup slot holds a version from before
  the disable; leaving it would keep offering "restore previous version" across
  a state the user chose deliberately. The rollback semantics themselves are
  lifecycle 4/6.
- **A move that cannot succeed is named, not retried.** Renames retry on the
  transient Windows `EPERM`/`EBUSY`; a cross-device `EXDEV` is permanent — the two
  locations are on different volumes, or the filesystem will not rename a
  directory at all — so it gets its own message rather than "close other apps
  using it".
- **Data deletion is a conservative, fixed list**, computed by
  `userDataPathsForPlugin`: the plugin's own `plugin_data/<id>` directory, any
  literal `plugin_data/<id>.*` sibling, and `pip_packages/<id>`. The rest of the
  backend's config layout is left alone. The renderer never chooses this — the
  main process asks, so a compromised renderer cannot turn "uninstall" into
  "delete data".
- **A dev checkout is never moved or deleted through a lifecycle path.** A
  symlinked copy is refused for install, disable and downgrade, and removal
  unlinks rather than following. The installer's own roots
  (`.feedback-disabled`, `.feedback-backups`) are checked on every path that
  writes or deletes through them: `rename` and `rmSync` resolve every path
  component but the last, so a link there would move or delete a directory
  outside the plugins dir. A removal is refused whole rather than half-done.
- **Restarting the backend is part of the operation, not an afterthought.**
  Enable, disable, update and downgrade each restart the Python backend and wait
  for it, so the next operation sees the state the last one left.

## Rolling back a bad update (4/6)

When an update or downgrade fails to activate, the previous version is restored
from the backup slot and the backend restarted so the restored copy loads again.
This happens automatically during the install flow, and the user can trigger it
manually too: the catalog row shows a "Restore previous" button whenever
`canRollback` is true (a backup is kept and the plugin is not disabled).

The row also carries a `recoveryInstructions` string whenever a recovery path is
available. When a backup is present it tells the user to restore the previous
version; when the backup has already been committed away but the record still
holds earlier versions it tells the user to downgrade instead. Neither is shown
for a disabled or uninstalled copy — neither has a live activation to recover.

- **After a failed activation the backup is restored, then the backend restarts.**
  `installOverInstalled` and `rollbackCatalogPlugin` both restart the Python
  backend after restoring, so the recovered version is live without the user
  having to ask twice. A restart that cannot happen is reported in the message.
- **Recovery instructions are derived, not stored.** They are computed in
  `lifecycleView` (see `src/main/plugin-lifecycle.ts`) from `canRollback` and
  `downgradeVersions`, so the advice the screen gives always matches the button
  the screen actually offers.
- **The record is rewritten to the restored version.** `rollbackCatalogPlugin`
  calls `recordAfterRollback` after `rollbackInstall` returns `'restored'`, so the
  installed-state record describes the copy that is now on disk — the version
  that was rolled back from becomes the newest entry in `previousVersions`,
  and the pin is cleared. When the restored version's identity cannot be
  recovered from the record (no history pin), the record is dropped rather than
  left claiming a version that is no longer on disk.

## First-run guided selection

A fresh install does not need every optional plugin, so the first launch offers
a wizard (`src/main/wizard.html` + `wizard.js`, driven by
`src/main/plugin-wizard.ts`): pick instruments and features, review the resolved
selection, download it in one batch with progress and cancellation. Skipping
leaves the fully working app behind, the wizard can be reopened from the Plugin
Manager ("Setup wizard"), and an interrupted run resumes without reinstalling
what already completed.

The wizard window loads a dedicated minimal bridge (`wizard-preload.ts`, in the
shape of `splash-preload.ts`), not the full desktop preload: it can read catalog
state and drive the batch it started, and nothing else — no audio engine, no
destructive maintenance actions.

The decisions are pure functions in `src/main/plugin-selection.ts`, and they are
**data-driven from the catalog** — no per-plugin UI rules:

| Catalog field | Effect |
| --- | --- |
| `instruments` | Becomes an instrument question; a chosen instrument recommends every entry tagged with it, and entries with no tags (instrument-agnostic) once anything is chosen. |
| `category` | Becomes a feature question; a chosen category recommends that category's entries. |
| `selection.tier` | `essential` is never a choice (always selected, and always part of the install set); `hidden` is never offered or recommended and only arrives as somebody else's dependency; `recommended`/`optional` are ordinary choices. |
| `selection.defaultSelected` | Recommended even with no answers given. |
| `dependencies` | Pulled in automatically, locked in the review list, ordered before their dependents. |
| `conflicts` | Pruned deterministically: auto-added dependencies win over `essential` entries, which win over plain preferences. A dropped dependency drops its dependents too. |

So adding an entry — or a new instrument or category — changes what the wizard
offers with no code change. Question labels are derived from the tag itself
(`import_export` → "Import Export").

Onboarding state lives in the desktop configuration
(`<userData>/slopsmith-desktop.json`, `pluginSetup`): `completed` records that
the wizard was finished *or* skipped, and `pendingIds` records a selection an
interrupted run still owes so reopening resumes exactly those entries.

What those two fields *mean* is pure logic in `src/main/plugin-setup-state.ts`,
including the rule that decides whether a wizard window close counts as the user
skipping: a close the user made themselves is a decision (and the only escape
from a resume whose batch keeps failing), while a close the app caused — a quit,
or the renderer startup giving up — leaves the state untouched so a launch that
never worked cannot consume onboarding. The first-run trigger is gated on the
renderer origin, so it opens over the app rather than over one of Chromium's
error pages.

Both install entry points go through one resolver in `plugin-manager.ts`
(`planCatalogInstall`), so a catalog entry that declares a dependency installs
from the wizard *and* from the Plugin Manager instead of failing with
"X requires Y" on one of them.

No account is required (public catalog only) and no analytics or telemetry is
collected or introduced by onboarding.
