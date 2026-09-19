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

## Remaining signing configuration

The September 19 inspection found no `windows-signing` Environment and no
registered signing runner. This is the remaining external prerequisite, not an
Actions compute-quota problem. Configure the upstream signer on a dedicated
Windows x64 build machine, with runner labels:

```text
self-hosted, Windows, X64, agentrouter-signing
```

Restrict the `windows-signing` GitHub Environment to main and configure:

| Kind | Name | Value source |
| --- | --- | --- |
| Variable | `DSH_DESKTOP_WINDOWS_CER_FILE` | Absolute path to the public code-signing certificate on that worker |
| Variable | `DSH_DESKTOP_WINDOWS_SIGNTOOL` | Absolute path to its upstream-compatible SignTool |
| Variable | `DSH_DESKTOP_WINDOWS_KEY_CONTAINER` | The provisioned signing key container |
| Secret | `DSH_DESKTOP_WINDOWS_TOKEN_PIN` | Signer PIN, supplied only to the packaging step |

The existing adapter uses upstream SafeNet signing. Another signing service
needs an explicit narrow signer integration and the same Authenticode and
timestamp acceptance. Self-signed certificates do not establish trusted Windows
publication. No certificate, PIN or private key belongs in the repository.

## Publish and verify the same signed bytes

After the accepted product input has `candidateOnly: false` and signing works:

```text
gh workflow run release.yml --repo Maybank01/agentrouter-desktop-releases --ref main -f delivery=coordinated -F publish=true
```

The workflow repeats candidate acceptance, signs the product, stages a draft,
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

## User transition

Users of the previous website DSH Desktop install the new product once from the
website. Supported Profile data migrates on first launch; the old application
is not automatically uninstalled. Subsequent updates use the product's one
update entry. Independently installed official/community DSH keeps its own
client update policy and can update the same npm plugin separately.

Plugin `next`, the desktop product release and model-account origin are distinct
settings. Packaging does not silently migrate accounts or change model traffic.
