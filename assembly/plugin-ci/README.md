# Private plugin validation on public Windows workers

The independent `plugin-validation.yml` workflow validates the AgentRouter plugin
used by this product. The feature source and candidate storage remain in private
`Maybank01/agentrouter-dsh-plugins`; npm publication remains in its protected
publisher. This workflow never publishes a Desktop installer or npm package.

Dispatch `verify`, `candidate`, or `sync` on this repository's `main`, with a full
source commit SHA and a unique lowercase request identifier. Every task must
reference an ancestor of private source `main`. Pull-request heads and synthetic
merge commits are not accepted, regardless of the author's repository role.
The helper binds every result to its source SHA, executor workflow SHA, run ID,
attempt and request ID. Concurrent upstream synchronizations are serialized.

Configure `AGENTROUTER_CI_TOKEN` as an **environment secret**, not a repository
secret, in both repositories' `plugin-ci` environments using a fine-grained
credential limited to these two repositories (or replace it with short-lived
GitHub App tokens). Private source/candidate transport needs Contents read/write;
dispatch and run inspection need Actions read/write; DSH compatibility PRs need
Pull requests read/write. Do not copy a broadly scoped local GitHub credential.
Restrict each environment to its `main` branch; no human approval is needed. The
public default token cannot read private source. Missing configuration fails
the task; code availability does not establish successful operational migration.

Credentials enter only source checkout and private result delivery steps. Builds
run without them. These phases share a worker, so removing a token from the build
environment is not a sandbox for unreviewed code. Only reviewed source already on
main is eligible. Git authorization is per process, never persisted in checkout.
Private source and all private process output stay under the temporary runner
directory; there are no public artifacts or caches. Public Actions output contains
only stage/status messages. Failure logs and `result.json` are retained in the
private prerelease `client-ci-<request_id>`; the receipt is uploaded after logs and
includes their SHA-256 hashes. Validation has a 75-minute soft timeout that stops
the process tree and allows final evidence delivery within the 90-minute job.
Hard cancellation, a lost worker, or credential/storage failures can prevent the
receipt from being saved; missing evidence is never a successful result.
Successful candidate tasks additionally use the
existing private exact-candidate store. Failed sync validation may still produce a
draft compatibility PR after successful dependency alignment.

Run `npm test` here for the executor's identity, source authorization, credential,
private log and receipt tests. End-to-end acceptance additionally requires a real
independent public Windows run and private evidence readback. Standard public
GitHub-hosted compute is free under current GitHub billing rules; storage, API and
scheduling limits still apply.
