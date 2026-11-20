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
`sandbox: true`. Preload exposes only static platform metadata under `window.jarvis`;
it exposes no IPC, filesystem, process execution, or generic Electron APIs.
Navigation, new windows, webviews, and permission requests are denied. The CSP
permits the development-only inline scripts/styles required by Vite Fast Refresh;
the built renderer disallows inline scripts/styles. Development network access is
restricted to the Vite origin and its HMR WebSocket.

Jarvis reads runtime settings from its process environment. It does not load
`.env` files. See `.env.example` for the optional service settings.
`JARVIS_DEV_URL` is set internally by the development runner; it accepts only an
HTTP loopback origin and is ignored in packaged mode. Do not set it for `npm start`.
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
status are tracked in issues #8 and #5.

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

## Prompt IPC

`window.jarvis.sendPrompt(prompt)` accepts a string from the Jarvis window.
Electron trims it, checks the 10,000-character limit, and POSTs
`{prompt,timestamp}` to `http://127.0.0.1:<port>/webhook/jarvis-prompt`.
The port uses the same `JARVIS_N8N_PORT` setting as the n8n supervisor.
The request has a 120-second deadline and a 1 MiB response limit.

An active workflow should return a non-empty JSON string or a JSON object with a non-empty `output` string.
The bridge returns `{success:true,data:{output}}` or
`{success:false,error:{code,message,retryable}}`. Jarvis does not log prompt
contents or upstream response bodies. The production workflow is tracked in issue #9.

## Contribution workflow

Before each issue, run `git fetch origin`, switch to `main`, and run
`git pull --ff-only origin main`. Create a new issue branch from that updated
`main`. Preserve local changes.
Implement and verify on the issue branch, then push it and open a draft pull
request targeting `main`. Merge only with authorization. Commit the npm lockfile
so `npm ci` reproduces dependency versions.

After confirming the PR merged, move its linked issue to **In Review** on the
Jarvis project board.

The [implementation plan](docs/IMPLEMENTATION_PLAN.md) tracks the remaining backlog.
