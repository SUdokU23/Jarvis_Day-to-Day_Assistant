# Jarvis Day-to-Day Assistant

Windows desktop foundation using Electron, React, Vite, and Tailwind CSS v4.
Jarvis checks and manages local Ollama and n8n servers on Windows. The desktop
window opens while the services start and remains usable if either is unavailable.

## Setup

Install **Node.js 24 LTS** (includes npm) and Git. In this directory:

```powershell
npm install
npm run dev
```

Vite binds only to `127.0.0.1:5173` and fails if that port is occupied. The runner
awaits Vite's listening server and passes its resolved URL to Electron. Closing
the Electron window or pressing Ctrl+C shuts down the owned development processes.
React updates live; restart the command after editing main/preload code.

To load built assets without a running Vite server:

```powershell
npm run build
npm start
```

The build uses relative asset paths for Electron's `file:` URL. `npm start`
loads `dist/index.html`; `npm run dev` explicitly selects the dev server. Packaged
mode always selects built assets. Installer packaging is outside issue #1.

## Verification

```powershell
npm ci
npm run build
npm run smoke
npm run dev -- --smoke-test
node --test electron/sidecars.test.cjs
```

Both smoke commands launch real Electron with a hidden window and fail unless
React renders, Tailwind styles apply, the preload bridge works, and renderer
Node globals are absent with isolation/sandboxing enabled. They exit automatically.
For a visible check, run `npm run dev`, confirm the styled Jarvis welcome screen,
close it, and confirm port 5173 is released. Repeat with `npm start` after building.
See [verification evidence](docs/VERIFICATION.md).

If launching from a tool environment that sets `ELECTRON_RUN_AS_NODE`, remove it
from that terminal first (`Remove-Item Env:ELECTRON_RUN_AS_NODE` in PowerShell).
That Electron diagnostic flag runs the binary as Node instead of opening the app.

## Security and configuration

The renderer has `contextIsolation: true`, `nodeIntegration: false`, and
`sandbox: true`. Preload exposes platform metadata, prompt submission, and
service status under `window.jarvis`. Main validates the calling frame and its
renderer URL before handling requests.
Electron denies renderer navigation, redirects, popups, webviews, downloads,
and permissions. The development CSP permits inline scripts and styles for
Vite Fast Refresh and limits connections to the Vite origin and its HMR WebSocket.
The built HTML carries a CSP that blocks inline scripts, inline style elements,
and renderer network requests. The built app loads `dist/index.html` directly.

Jarvis reads runtime settings from its process environment. It does not load
`.env` files. See `.env.example` for the optional service settings.
`JARVIS_DEV_URL` is set internally by the development runner; it accepts only an
HTTP IPv4 loopback origin with an explicit port and is ignored in packaged mode.
Do not set it for `npm start`.
Do not commit local secrets or runtime data.

## Ollama on Windows

Install [Ollama for Windows](https://docs.ollama.com/windows). Jarvis probes
`http://127.0.0.1:11434/api/version` and reuses a running Ollama server.
When the endpoint refuses the connection, Jarvis starts `ollama serve` in a
Windows Job Object with `OLLAMA_HOST=127.0.0.1:11434`. It checks the standard
per-user install directory and then tries `ollama.exe` from PATH. Set
`JARVIS_OLLAMA_EXECUTABLE` in the launch environment for a custom installation.

Each health request has a two-second timeout, and startup has up to 60 seconds
to become healthy. Jarvis checks again every five seconds after startup and
reports recovery if Ollama becomes reachable. If managed startup times out,
Jarvis closes its process tree. Restart Jarvis to retry managed startup, or
start Ollama separately and Jarvis will detect it.

On quit, the Job Object closes the launcher and its descendants. Existing
Ollama instances remain running. Main-process logs include state changes,
launcher failure codes and output byte counts. Model readiness and sidebar
status are tracked separately. Sidebar integration is tracked in issue #5.

### Install and verify the local model

With Ollama running, open PowerShell and run:

```powershell
ollama pull llama3.2
ollama list
ollama run llama3.2 "Reply with a short greeting."
```

The default 3B model download is about 2 GB. Allow additional RAM or VRAM for
inference, which varies with context length and hardware. The `llama3.2:1b`
variant is about 1.3 GB. Pulling the model requires a network connection.
Once downloaded, the invocation runs locally without cloud API credentials.

Jarvis checks the local inventory at `/api/tags` and logs the configured
model's state separately from server health. `ready` means the model is listed,
`missing` means it needs to be pulled, and `check-failed` means the inventory
could not be read. Jarvis checks again on the next health cycle. Use the
invocation command above to verify generation on your hardware.

To use a different model, pull it, set `$env:JARVIS_OLLAMA_MODEL = 'llama3.2:1b'`
in the PowerShell session that launches Jarvis, and restart Jarvis. Use the
same identifier in the n8n Ollama model node when configuring the workflow.

## n8n on Windows

Install [n8n with npm](https://docs.n8n.io/hosting/installation/npm/) and make
`n8n.cmd` and a compatible `node.exe` available on PATH. Set
`JARVIS_N8N_EXECUTABLE` to an absolute path to the standard npm `n8n.cmd` shim
or an executable that accepts the `start` argument for a custom installation.
Set `JARVIS_N8N_PORT` to change the default port of 5678.

Jarvis calls `/healthz` and `/healthz/readiness` on IPv4 loopback before launching.
A server returning n8n's healthy responses is reused. An unrelated or unresponsive
listener blocks managed startup on that port. Start an external instance with
the standard health routes, or choose a free port and restart Jarvis.

Jarvis starts managed n8n on loopback with a persistent profile at
`<Electron userData>/n8n/.n8n`. n8n generates its encryption key there on first
launch. Open `http://127.0.0.1:5678` (or your chosen port) to complete n8n's
owner setup. Keep backups of the profile private. Jarvis waits up to 60 seconds
for managed startup, checks health every five seconds afterward, and closes only
its own process tree on quit. Main-process logs report safe lifecycle codes.

Keep external n8n and Ollama listeners on loopback too. Jarvis probes local
endpoints and cannot verify the interfaces an external instance listens on.
Keep the n8n owner login enabled and avoid forwarding the editor or webhook port.
Review the workflow's execution retention settings because n8n can store prompts
and replies in execution history.

The n8n editor login and production webhook authentication are configured
independently. The shared workflow imports without credentials. To require
webhook authentication, set the Webhook node's Authentication to **Header Auth**,
create a credential named for the header `X-Jarvis-Webhook-Token`, and publish
the workflow. Use a random token of 1–256 printable non-space ASCII characters.
Store the same value in a UTF-8 text file outside the checkout with Windows
permissions limited to your account. Set `JARVIS_N8N_WEBHOOK_SECRET_FILE` to
its absolute path in the environment that launches Jarvis, then restart Jarvis.
Only the main process reads the token. Keep credentials, token files, and
execution exports out of source control.
[n8n Webhook documentation](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/)

## Prompt IPC

`window.jarvis.sendPrompt(prompt)` accepts a string from the Jarvis window.
Electron trims it, checks the 10,000-character limit, and POSTs
`{prompt,timestamp}` to `http://127.0.0.1:<port>/webhook/jarvis-prompt`.
The port uses the same `JARVIS_N8N_PORT` setting as the n8n supervisor.
The request has a 120-second deadline and a 1 MiB response limit.

An active workflow should return a non-empty JSON string or a JSON object with a non-empty `output` string.
The bridge returns `{success:true,data:{output}}` or
`{success:false,error:{code,message,retryable}}`. Jarvis does not log prompt
contents or upstream response bodies.

Import [the shared n8n workflow](workflows/base_agent.json) into the n8n
instance listening on `JARVIS_N8N_PORT`. Follow the [workflow setup](docs/N8N_WORKFLOW.md)
to configure local Ollama and publish the production webhook. See the
[Windows smoke tests](docs/SMOKE_TESTS.md) for verification commands and results.

## Contribution workflow

Before starting any issue, recheck the live issue, run `git fetch origin`, switch to `main`, and always run
`git pull --ff-only origin main`. Create a new issue branch from that updated
`main`. Preserve local changes.
Implement and verify on the issue branch, then push it and open a draft pull
request targeting `main`. Merge only with authorization. Commit the npm lockfile
so `npm ci` reproduces dependency versions.

After confirming the PR merged, move its linked issue to **In Review** on the
Jarvis project board.

The [implementation plan](docs/IMPLEMENTATION_PLAN.md) tracks the remaining backlog.
