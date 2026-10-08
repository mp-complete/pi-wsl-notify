# @mp-complete/pi-wsl-notify

Cancellation-aware **Windows toast notifications for Pi running in WSL**, with
short AI summaries of the last run.

```text
Pi · my-project · Ready
Updated the notifier; checks passed. Review the changes.
~/src/my-project · 2m 14s
```

- **Cancellation stays silent.** Normal completion and terminal errors notify.
- **At most 140 characters** of summary, with directory, duration and tool-error
  count shown separately.
- **Same-provider utility model:** defaults to `gpt-5.6-terra`, using Pi's model
  registry and existing credentials. Never silently switches providers.
- **Non-blocking:** Pi accepts input while the summary is generated. New work
  cancels pending notifications, and failed/slow summaries use a local fallback.
- **WSL-specific:** direct Windows toasts, including under tmux, without relying
  on `WT_SESSION`, terminal OSC support, or a Linux desktop notification daemon.

> **Privacy:** AI summaries are enabled by default and send bounded excerpts of
> your latest request, final reply, and recent tool results to the active
> provider. Tool results may contain private code or work data. Read
> [Data and model policy](#data-and-model-policy), or set `"summarize": false`
> before using the extension to keep notifications local.

## Status and requirements

Initial package version: **0.1.0**. This repository is prepared for npm publication;
the initial npm release has not been published yet.

- Node.js **22.19+**.
- Pi **1.0.0**, using the `@earendil-works` packages. The implementation uses that
  version's `agent_before_settle`, `agent_settled`, mode and model-registry APIs.
  Older Pi releases are not supported; later versions need compatibility checks.
- An interactive Pi **TUI in a TTY**, running in **WSL**. Print, JSON, RPC,
  non-WSL and headless sessions do not emit notifications or summary requests.
- Windows interop and `powershell.exe` on WSL's `PATH`. Windows notifications
  must be enabled. Do Not Disturb and other Windows delivery policies still apply.

The Pi peers use `"*"` as required by Pi's package contract; this is not a promise
of compatibility with every Pi version. Pi supplies those packages at runtime;
this package has no other runtime dependencies or install-time scripts.

## Install

After the npm release is published, an ordinary mutable Pi installation can use:

```sh
pi install npm:@mp-complete/pi-wsl-notify@0.1.0
```

For development from a checkout:

```sh
pi --extension ./extensions/wsl-notify.ts
```

**Disable any other completion notifier first**, especially Pi's official
`examples/extensions/notify.ts`. This package does not unregister someone else's
handlers; loading both produces duplicate notifications. Installation commands
are shown for users, not run by the tests.

### Declarative Nix installations

Do not run mutable `pi install` for a Nix-managed Pi wrapper. Pin the published
npm tarball and integrity hash through your wrapper's packaging API. The package
has one self-contained TypeScript entrypoint (`extensions/wsl-notify.ts`), so
`pi-nix-wrapper`'s `mkPiExtension` is sufficient once the release exists:

```nix
extensions = [
  (piWrapper.lib.mkPiExtension {
    inherit pkgs;
    npmPackage = "@mp-complete/pi-wsl-notify";
    version = "0.1.0";
    hash = "sha512-REPLACE_WITH_PUBLISHED_DIST_INTEGRITY";
    entrypoint = "extensions/wsl-notify.ts";
  })
];
```

`piWrapper` is your existing wrapper flake input; this example is a template,
not an evaluated configuration. Remove the previous notifier from your wrapper's
extension list. A local source file can instead be passed directly while testing.

## Controls

| Command | Effect |
| --- | --- |
| `/wsl-notify` or `/wsl-notify status` | Show effective settings, config path and last delivery status in Pi. No test toast or model request. |
| `/wsl-notify mute` | Mute for this loaded extension runtime and cancel pending notification work. |
| `/wsl-notify unmute` | Lift session mute; does not override persistent disable or replay missed runs. |
| `/wsl-notify reload` | Reload the file and discard active/pending notification state; preserves session mute. |

Optional **user-only** configuration is read from:

```text
<agent-dir>/wsl-notify.json
```

The agent directory is normally `~/.pi/agent`. A wrapper may use a different
location; for example, `pi-next` commonly uses `~/.config/pi-next`. Pi's selected
agent directory and `PI_CODING_AGENT_DIR` override are respected. Project-local
configuration is intentionally not read.

No file is created or overwritten by the extension. Absent file = these defaults:

```json
{
  "enabled": true,
  "summarize": true,
  "model": "gpt-5.6-terra",
  "notifyOn": ["completed", "error"],
  "minDurationMs": 0,
  "summaryTimeoutMs": 8000,
  "sound": false
}
```

All keys are optional. Unknown keys, malformed JSON, or invalid values **disable
notifications** until fixed and reloaded.

| Setting | Meaning |
| --- | --- |
| `enabled` | Persistent on/off. |
| `summarize` | Enable utility-model requests; `false` uses local generic text. |
| `model` | Exact chat-model ID on the active provider. |
| `notifyOn` | Array containing either/both `completed` and `error`, or empty. Cancellation is never selectable. |
| `minDurationMs` | Minimum run duration, integer 0–3,600,000. Default includes short runs. |
| `summaryTimeoutMs` | Hard summary deadline, integer 100–30,000. Default eight seconds. |
| `sound` | Request normal Windows notification sound; default is silent. OS policy still applies. |

Run `/wsl-notify reload` after editing. A full Pi `/reload` replaces the extension
runtime and resets transient mute/status; use `enabled: false` for persistent
mute. Disabling summaries does not require model credentials.

## Notification semantics

The title is `Pi · <directory basename> · Ready` or `Error`:

- **Ready** means the main session stopped normally, not that every requested
  task succeeded or all detached work finished.
- **Error** means the final agent outcome was an error.
- The body prioritizes results, important failures/blockers, or a user decision.
  Generated text can be wrong; the Pi transcript is authoritative.
- Metadata includes Pi's **`ctx.cwd` at settlement**, home-abbreviated, plus run
  duration (excluding summary/delivery time). A `cd` inside a temporary shell
  does not change Pi's working directory. Long directory labels are truncated.
- Recorded tool errors are labelled **during run** because a later step may have
  fixed them. They don't turn a normal final outcome into `Error`.
- Fallback text is `Ready for input. Check Pi for the result.` or
  `Run failed. Check Pi for details.`, labelled `No AI summary`.

Toasts are emitted only on **`agent_settled`**, not `agent_end`, so automatic
retries, compaction recovery, and queued continuations can finish first.
Cancellation is detected through run abort signals, aborted messages/outcomes,
and the configured `app.interrupt` key during gaps with no active run signal.
Input is observed, not consumed; Escape within a blocking extension dialog is
not treated as cancelling the whole run. During active streaming, the actual
abort signal is authoritative rather than the key alone.

The final pre-settle boundary is required. Pi skips it for cancellation during
retry/compaction; fail silent rather than notifying from an earlier successful
or failed message. Unusual runtime failures that bypass this boundary can also
be silent.

Starting another run, submitting input, interrupting, navigating sessions,
shutting down, changing models, running a user shell command, muting, or reloading
cancels pending notification work. Late summaries cannot overwrite a newer job.
A toast already handed to Windows cannot be recalled; cancelling an in-flight
PowerShell process is best effort.

Toasts use the **Pi** app identity, a per-session tag, the `pi-wsl-notify` group,
and five-minute expiration. This replaces earlier notifications for the same
session without merging different sessions. No app registration or Windows
settings are changed. There is no toast click handler or terminal-focus action.

**Not implemented:** focus-based suppression, approval/question notifications
mid-run, individual subagent notifications, Linux notifications, terminal
notification protocols, terminal bells, or toast actions.

## Data and model policy

The default `gpt-5.6-terra` is looked up **only on the active session's provider**.
A missing model or unavailable credentials falls back locally rather than
choosing another provider. Catalog presence doesn't guarantee subscription
access; request-time errors also fall back.

Providers with prefixed IDs need an explicit setting, for example
`"model": "openai/gpt-5.6-terra"` for OpenRouter. This is a model ID, not a
`provider/model` routing selector. Virtual/custom providers without the selected
model fall back as well. The main conversation model is never changed.

At most one utility request is attempted per qualifying run, containing:

- Latest delivered user-request text, including steering: **1,200 code points**.
- Last assistant-message text: **4,000 code points**.
- Last six top-level tool outcomes: name, error flag and **700 code points** of
  text each, plus total tool/error counts. Nested outcomes aren't counted twice;
  enclosing tool text can include their output. Excerpts are marked truncated.

No prior history, system prompt, thinking blocks, images, tool arguments or
result `details` are included. The directory is added locally, not explicitly
sent to the model, though paths can occur in excerpts. Recognizable credentials
are redacted as defense in depth, **not a guarantee of secret removal**.

The same-provider rule avoids an implicit provider switch but **does not make
requests local**. Treat the configured provider as the data recipient, and
remember that summary text may appear on screen or in Windows notification
history. Disable summaries for material you shouldn't send. The utility model
is instructed to treat excerpts as untrusted data and has no tools.

Requests have a hard deadline, a 256-token output budget, no requested reasoning,
no provider retries and no requested prompt caching. Cancellation is best effort.
Requests can incur charges or use subscription quota; their usage is **not added
to Pi's main conversation totals**. No extra agent/session is created and no
summary is written into history, a file, or a persistent extension log.

Toast content is flattened, sanitized, capped and XML-escaped. Only base64 data
and a hex tag enter a fixed PowerShell script. `powershell.exe` is invoked without
a shell, profiles or interaction, with a five-second timeout. No generated
commands, actions or temp files are used. Failures produce a generic in-Pi
warning without exposing payloads or PowerShell stderr. Successful submission
does not prove Windows displayed the toast.

## Development and validation

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm pack --ignore-scripts --dry-run
```

`npm run check` typechecks against pinned Pi 1.0.0 development dependencies and
runs Node's test runner. The extension tests mock all side effects: filesystem,
models, terminal input, timers and PowerShell. They cover cancellation, retry and
settlement boundaries, stale-result races, timeout/fallback, configuration,
provider isolation, data bounds/redaction, XML safety and transport failures.
The package tests inspect the npm manifest and exact tarball allowlist. Runtime
source is shipped as TypeScript; there is no compiled output or build step.

CI runs these checks on Node 22 and 24. It has read-only repository permissions
and **does not publish**. Tests do not call a live model, run authentication,
start a Pi agent, or send Windows notifications.

Not yet verified live: Terra quality/latency/access, Windows toast display/sound,
OS notification settings, and real terminal key/overlay behavior. The original
Nix consumer also passed a Pi extension-loading smoke test, but that is not a
live desktop integration test.

See [RELEASING.md](https://github.com/mp-complete/pi-wsl-notify/blob/main/RELEASING.md)
for the manual publication checklist.

## License

MIT. The Windows toast approach builds on Pi's official notification example;
see [NOTICE](NOTICE) and [LICENSE](LICENSE). Pi itself is host-provided, not bundled.
