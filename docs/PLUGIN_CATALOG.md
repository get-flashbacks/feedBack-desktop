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
