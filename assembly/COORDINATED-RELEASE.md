# Coordinated client release

This repository publishes the official DSH Desktop assembly. The plugin stays
independently installable from npm. A product version binds one DSH version and
one immutable, already published plugin tarball in `coordinated/release.json`.
The native source owner is `Maybank01/agentrouter-desktop/assembly/coordinated`;
commit there and export with its `export-release-adapter.mjs` before updating this
repository. Do not edit the exported adapter here.

## Accepted candidate

Run on main after the exact npm package is publicly readable:

```text
gh workflow run release.yml --repo Maybank01/agentrouter-desktop-releases --ref main -f delivery=coordinated -F publish=false
```

The disposable Windows job installs the current product, runs the native updater
from the previous baseline and migrates the preceding public Desktop Profile.
It checks retained credentials, conversation, user configuration, third-party
plugins and the single product update entry. Its unsigned installers use only a
loopback feed. Retain the run URL and final receipt; a source test or directory
build alone is not installed acceptance.

## Self-signed release configuration

The user selected self-signing on September 19. Standard hosted Windows workers
use Windows SDK SignTool; no paid service or self-hosted signing runner is needed.
The `windows-signing` Environment is restricted to main and contains:

| Kind | Name | Value source |
| --- | --- | --- |
| Secret | `AGENTROUTER_SIGNING_PFX` | Base64-encoded encrypted dedicated PFX |
| Secret | `AGENTROUTER_SIGNING_PASSWORD` | Its password, available only during import |

Only the public certificate and key are committed in `windows-signing.json`.
The PFX is imported into CurrentUser/My and deleted; an always-run cleanup removes
the temporary key. Root and TrustedPublisher stores are never modified.

The app embeds the public key in asar and uses electron-updater's existing
verification hook to check `agentrouter-update.json` and the full installer bytes,
including cached downloads. Receipt fields retain the actual Authenticode status
and explicitly distinguish self-signing from public Windows trust. Windows may
show an initial installation warning; the download page and release notes say so.
Keep the stable key; a future rotation needs a bridge release signed by the old
key before retiring it. A broad workstation GitHub credential is not a CI secret.

## Publish and verify the same signed bytes

After the accepted product input has `candidateOnly: false` and signing works:

```text
gh workflow run release.yml --repo Maybank01/agentrouter-desktop-releases --ref main -f delivery=coordinated -F publish=true
```

The workflow repeats candidate acceptance, signs the product, verifies a native
signed update/restart without installing a root certificate, then stages a draft,
then installs those exact signed bytes on a separate hosted Windows worker.
Only then does it publish the draft. Its final anonymous check verifies the
installer, blockmap, updater feed and both receipts. The website uses
`release-receipt.json` and `signed-installed-acceptance.json` to recognize the
new client; a test-only or unsigned candidate cannot enter that path.

If only final public observation fails, rerun the failed publish job from that
same workflow run after inspecting the failure. It downloads the original
assets and retains the original installed receipt. It never replaces published
assets, rebuilds an installer under the same version or moves a newer latest
release backwards. A changed package or installer requires a new version.

If the publisher itself needs a reviewed fix after signing, resume from current
main using the original completed run ID:

```text
gh workflow run release.yml --repo Maybank01/agentrouter-desktop-releases --ref main -f delivery=coordinated -F publish=true -f resume_signed_run=<original-run-id>
```

Recovery requires the original main dispatch's candidate and signed-upgrade jobs
to have passed. Its source must be an ancestor, and the complete exported adapter
and product recipe must remain byte-identical. The new worker verifies and installs
the existing signed assets again; it does not rebuild, sign, replace assets or
change their source identity. The installed receipt also records the verifier's
current commit. Draft lookup uses the Release ID because the REST tag endpoint
only resolves published releases.

## User transition

Users of the previous website DSH Desktop install the new product once from the
website. Supported Profile data migrates on first launch; the old application
is not automatically uninstalled. Subsequent updates use the product's one
update entry. Independently installed official/community DSH keeps its own
client update policy and can update the same npm plugin separately.

Plugin `next`, the desktop product release and model-account origin are distinct
settings. Packaging does not silently migrate accounts or change model traffic.
