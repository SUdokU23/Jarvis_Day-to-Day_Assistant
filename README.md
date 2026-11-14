# Jarvis Day-to-Day Assistant

Windows desktop foundation using Electron, React, Vite, and Tailwind CSS v4.
Issue #1 establishes startup and the security boundary. Chat, n8n, and Ollama
integration are subsequent backlog issues; they are not required to launch this scaffold.

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

No `.env` file is needed or loaded yet. `.env.example` documents this boundary.
`JARVIS_DEV_URL` is set internally by the development runner; it accepts only an
HTTP loopback origin and is ignored in packaged mode. Do not set it for `npm start`.
Do not commit local secrets or runtime data.

## Contribution workflow

Before implementation, fetch and pull latest `main` with `git pull --ff-only`,
then create a new issue branch from that updated `main`. Preserve local changes.
Implement, verify, and prepare a pull request targeting `main`; do not merge
automatically. Commit the npm lockfile so `npm ci` reproduces dependency versions.

The [implementation plan](docs/IMPLEMENTATION_PLAN.md) tracks the remaining backlog.
