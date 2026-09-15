# Optional upstream Desktop delivery

Client features belong to `Maybank01/agentrouter-dsh-plugins/plugins/dsh-codex`.
Use that repository's `DEVELOPMENT.md` for development and npm publication.
This repository only owns optional upstream preinstallation assembly and its
existing download assets. Keep the upstream source unmodified.

Plugin releases do not trigger Desktop builds. The installer workflow is
manual on main and is used only for an explicitly requested installer release.
Preserve historical release assets, update feeds and installed user data.
Run `npm test` for assembly/workflow configuration changes.
