# Optional upstream Desktop delivery

Client features belong to `Maybank01/agentrouter-dsh-plugins/plugins/dsh-codex`.
Use that repository's `DEVELOPMENT.md` for development and npm publication.
This repository only owns optional upstream preinstallation assembly and its
existing download assets. Keep the upstream source unmodified.

Plugin releases do not trigger Desktop builds. The installer workflow is
manual on main and is used only for an explicitly requested installer release.
Preserve historical release assets, update feeds and installed user data.
Run `npm test` for assembly/workflow configuration changes.

2026-09-17 approved delivery extension: `assembly/coordinated` is an exact export
from `Maybank01/agentrouter-desktop/assembly/coordinated`, recorded by
`adapter-source.json`. Develop native delivery changes there and re-export;
this repository remains the sole binary publisher. The limited official Desktop
adapter owns product identity, profile migration and coordinated updates. No
plugin source or DSH core/UI forks are permitted here.

Keep the historical community assembly and releases. New installer tests execute
only on disposable hosted Windows workers and use unsigned loopback-only feeds.
Formal coordinated publication requires an explicit main dispatch, a non-candidate
release input, configured upstream signing and installed acceptance of signed bytes.
Do not promote test installers or redirect third-party clients to this feed.
