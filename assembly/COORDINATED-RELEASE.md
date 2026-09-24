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

Timeline (2026-09-23; the previous serial path took about 34-40 minutes):

| Job | Worker | Typical |
| --- | --- | --- |
| Select reusable installed acceptance evidence | Ubuntu | < 1 min |
| Accept coordinated installers before signing (only without evidence) | Windows | ~14 min |
| Sign and stage the exact product release | Windows, `windows-signing` | ~5 min |
| Signed native update and restart / Signed legacy Profile migration / Install signed bytes on a clean worker (parallel) | 3 × Windows | ~9 min (longest) |
| Publish the accepted signed release and verify delivery | Windows | ~2-7 min |

With reusable evidence a release takes about 17-22 minutes; without it about 31-36.

**Evidence reuse.** `coordinated-evidence.mjs` looks for a successful `ci.yml`
run of this repository (never a fork) whose five jobs (source boundaries,
adapter transactions/store migration and the three installed scenarios) all
concluded `success` in their latest attempt. The run's tested tree must have
the same digest as the release commit over every file `ci-scope.mjs` marks as
requiring installed acceptance. This includes `adapter-source.json`, the
exported adapter, `release.yml` and the release scripts. A `pull_request` run
counts only when its PR base is an ancestor of the tested head, so its merge
tree equals the head tree. Its identity (run ID, attempt, job IDs, tested and
release tree SHAs, digest) is recorded as `acceptanceEvidence` in the receipt;
signing, every post-sign job and recovery re-check it against the release commit.
When no run matches, the release repeats the complete candidate acceptance and
records `installedCandidate` instead. `publish=false` always runs the candidate job.

**Parallel signed checks.** The sign job stages the draft with
`staged-release-receipt.json` (source commit, workflow run ID, pre-sign acceptance).
Three sibling jobs download that draft, require its receipt to name this commit
and this run, verify bytes, Authenticode and the signed manifest, then run on
separate disposable workers: the native signed update/restart from a signed
baseline (the only sibling holding the signing key), the previous public
Profile migration into the signed installer, and a clean installation with
runtime/credential recovery. Each attaches its record (`signed-native-update.json`,
`signed-legacy-migration.json`, `signed-fresh-install.json`) to the draft.
Publish needs all of them. It adds both signed summaries to the final
`release-receipt.json`, writes `signed-installed-acceptance.json` and then
publishes. Its final anonymous check verifies the installer, blockmap, updater
feed and both receipts. The website uses `release-receipt.json` and
`signed-installed-acceptance.json` to recognize the new client; a test-only or
unsigned candidate cannot enter that path.

**Unpublished drafts (owner decision 2026-09-23).** If a draft of the same
version exists and was never published (`draft: true`, `published_at: null`),
a new signing run deletes it and stages a fresh draft for that version. A
version that was ever published, or whose tag exists, is never replaced. A new
version must be newer than every published formal release, so latest never
moves backwards.

The same final step also checks the server-rendered Windows card at
`https://agentrouter.top/for-dsh`: its visible version, GitHub installer link,
mirror link and release notes must match the accepted product. The website's
GitHub metadata cache lasts 300 seconds, so observation retries for up to six
minutes. Hydration scripts or metadata containing the new version cannot mask
an old visible card. The checker then downloads the complete website mirror
and verifies its length and SHA-256 against the accepted installer. Workflow
success and its public delivery summary require all of these checks to pass.

If only final public observation fails, rerun the failed publish job from that
same workflow run after inspecting the failure. It downloads the original
assets and retains the original installed receipt. It never replaces published
assets, rebuilds an installer under the same version or moves a newer latest
release backwards. A changed package or installer of a published version
requires a new version; an unpublished draft may be re-signed as described above.
If a post-sign job fails, re-run the failed jobs of the same workflow run: they
reuse the staged draft and replace only their own record on it.

If the publisher itself needs a reviewed fix after signing, resume from current
main using the original completed run ID:

```text
gh workflow run release.yml --repo Maybank01/agentrouter-desktop-releases --ref main -f delivery=coordinated -F publish=true -f resume_signed_run=<original-run-id>
```

Recovery requires the original main dispatch's pre-sign acceptance (evidence
or candidate job), signing, signed native update and signed legacy migration
jobs to have passed, and the draft receipt to name that run. Reused evidence is
re-checked through its immutable job IDs and tested tree. Its source must be an ancestor, and the complete exported adapter
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

## 2026-09-24: hotfix profile, npm wait and release timeline

`release.yml` takes `profile: standard | hotfix` (owner-approved after the 3.0.19
lead time). `hotfix` defers only the unsigned pre-sign installed acceptance when
no identical-input ci.yml evidence exists: those scenarios are repeated on the
signed draft anyway (signed native update, signed legacy migration, clean-worker
install) and still run in ci.yml on the export PR and the main push. Signing,
Authenticode, the signed update manifest, every signed installed check and the
publication/feed verification remain gates. The staged and final receipts carry
`releaseProfile`; a receipt without pre-sign evidence is valid only with the
exact recorded hotfix deferral (`assembly/coordinated-signed.mjs`).

A release PR may be opened as soon as the plugin candidate is accepted:
`assembly/wait-plugin.mjs` (ci.yml `Locked plugin bytes on npm`, and the release
evidence job with `--require-next`) waits up to 20-30 minutes until npm serves
the locked version with the same integrity, size and SHA-256. A different
artifact fails immediately; a missing one fails after the bounded wait.

`Release timeline and budgets` measures every job's queue and duration against
`assembly/release-budgets.json`, writes the table to the run summary and, for
publishing runs, opens an incident issue when a job failed or a budget was
exceeded. The publish job also embeds the timeline in `release-receipt.json`.
A failed installed acceptance on a main push opens an incident as well, so a
hotfix published ahead of those suites is never silently unverified.
