# Optional upstream Desktop delivery

Client features belong to `Maybank01/agentrouter-dsh-plugins/plugins/dsh-codex`.
Use that repository's `DEVELOPMENT.md` for development and npm publication.
This repository only owns optional upstream preinstallation assembly and its
existing download assets. Keep the upstream source unmodified.

Plugin releases do not trigger Desktop builds. The installer workflow is
manual on main and is used only for an explicitly requested installer release.
Preserve historical release assets, update feeds and installed user data.
Run `npm ci --ignore-scripts --prefix assembly/coordinated`, `npm test` and
`git diff --check` for assembly/workflow configuration changes.

2026-09-17 approved delivery extension: `assembly/coordinated` is an exact export
from `Maybank01/agentrouter-desktop/assembly/coordinated`, recorded by
`adapter-source.json`. Develop native delivery changes there and re-export;
this repository remains the sole binary publisher. The limited official Desktop
adapter owns product identity, profile migration and coordinated updates. No
plugin source or DSH core/UI forks are permitted here.

`ci.yml` is the sole hosted CI for the Desktop adapter. It runs independently in
this public repository on standard Ubuntu and Windows workers, using only the
allow-listed export. It has no private-source checkout, cross-repository secret,
signing environment or candidate upload. Preserve the transaction, store
migration and installed update/legacy migration checks. Keep private repository
boundary checks local; do not claim this CI checks unexported source changes.
Follow `assembly/CI.md` for export, dispatch and exact-source acceptance.

Keep the historical community assembly and releases. New installer tests execute
only on disposable hosted Windows workers and use unsigned loopback-only feeds.
Formal coordinated publication requires an explicit main dispatch, a non-candidate
release input, configured signing and installed acceptance of signed bytes.
2026-09-19 user decision: use a self-signed certificate. The `windows-signing`
Environment is restricted to main; disposable hosted Windows signs with its
encrypted PFX secrets and removes its temporary CurrentUser/My key afterward.
The exported adapter pins the public update key and verifies a signed full-file
manifest through electron-updater's supported hook. Preserve that verification,
do not install trusted roots, and label the release self-signed rather than
publicly trusted. Native signed upgrade and separate installation of the same
final bytes are mandatory before publishing. Unsigned or signed loopback test
installers are never promoted or uploaded as release assets.
Do not promote test installers or redirect third-party clients to this feed.

Product plugin validation may run independently on public hosted Windows workers
through `plugin-validation.yml` and `assembly/plugin-ci`. This is execution glue,
not another feature source. Keep private checkout and process output in temporary
storage, send candidates and evidence only to the private plugin repository, and
retain its protected npm publisher. Read `assembly/plugin-ci/README.md` before
changing this cross-repository path. Do not add public source caches or artifacts.
