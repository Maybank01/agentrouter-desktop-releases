# Public update-page adapter

The portable AgentRouter plugin owns the About/update UI. This assembly exposes
the optional v1 JSON routes `/api/agentrouter/v1/updates/{status,check,download,install}`
on the existing `dsh-app://app` Connection Fetch transport. Its contract is
documented by `agentrouter-dsh-plugins/docs/UPDATE-CENTER.md` and `src/update-api.ts`.
It does not expose private native IPC to the plugin or create another updater.

The native menu and page share `DesktopUpdateCoordinator`. Download and restart
are separate operations for the page; the recovery menu retains its combined
operation. Automatic installation on quit stays disabled. Downloaded bytes are
retained while work is busy and verified again before restart. Host activity
must be known/idle, and the existing native `prepareRestart` reservation remains
the final race check. Unknown host activity disables the page's restart action.

`update-routes.mjs` is copied and bundled by `prepare.mjs`. Only the four exact
public paths are intercepted. Mutations require JSON, a matching known version,
an owned origin and a body at most 4 KiB. The adapter exposes no credentials,
filesystem paths or arbitrary URL authority. Installed plugin identity/activity
come from the running plugin's public status, through a direct host fetch.
Product identity comes from `app.getVersion()`; host and plugin versions are
never substituted for it. Older plugin versions can keep using the native menu.

Maintain actual published product history in `release-history.json`. Existing
3.0.8/3.0.7 records were transcribed from their public GitHub release bodies and
publication timestamps. Future release inputs may provide reviewed `releaseNotes`
with `{version,publishedAt?,changes:[{kind,text}]}`. Packaging writes bounded notes
and the exact input plugin version under `agentrouter` in `latest.yml`, before
asset hashes and the signed manifest are computed. Metadata affects display only;
the existing product target, pinned verifier and signed installer decide install
authority. Unavailable/malformed notes never imply a failed update check.

Local validation: repository boundary tests, native coordinator/transaction/
migration tests, route method/origin/body/version guards and idle/unknown behavior.
The source patch and route tests do not establish signed installed acceptance.
Before product delivery export the committed reviewed adapter and run the public
Windows CI's actual installation/update/migration checks. No new product version,
npm publication or installer/feed promotion is part of this feature implementation.
