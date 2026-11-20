# Issue #1 verification

Date: 2026-11-14 (Europe/Sofia). Branch: `feat/1-desktop-scaffold`.

## Environment and locked versions

Windows x64; portable Node 24.22.3/npm 11.19.1, stored outside the repository in
the workspace `.tools/` directory because Node/npm were absent from PATH.
React/React DOM 19.3.1; Electron 45.3.2; Vite 8.3.8; React plugin 6.3.0;
Tailwind and its Vite plugin 4.3.5. Exact versions and transitive integrity hashes
are committed in `package-lock.json`.

## Executed checks

| Check | Result |
| --- | --- |
| `npm install` | Passed; exact dependencies installed |
| `npm ci` | Passed; 0 reported vulnerabilities |
| `npm run build` | Passed; relative HTML/CSS/JS assets in `dist/` |
| `npm run smoke` | Passed in real Windows Electron loading built files, without Vite |
| `npm run dev -- --smoke-test` | Passed in real Windows Electron via `http://127.0.0.1:5173/` |
| Occupy 5173 with a loopback TCP listener, then run dev | Expected exit 1: port already in use; no fallback port |
| Query listening sockets after dev smoke/conflict check | No listener on 5173 |
| `node --check` for main/preload/dev runner/Vite config | Passed |

Both smoke checks returned heading `Jarvis`, platform `win32`, renderer
`require`/`process` types `undefined`, and Tailwind background
`oklch(0.129 0.042 264.695)`. They also checked live BrowserWindow preferences:
context isolation and sandbox enabled, Node integration disabled.
Production renderer JS is 69.18 kB gzip; CSS is 2.56 kB gzip.

The restricted shell initially blocked binary download/Chromium startup.
Installation and successful Electron runs used approved unrestricted execution.
The host tool also inherited `ELECTRON_RUN_AS_NODE=1`; it was removed from the
verification process environment. These failures were not passing tests.

## Review and limits

Self-review used the code-reviewer universal and JavaScript rule packs, covering
new files and the implementation-plan update. No blocking findings remain.
Reviewed secure preferences, preload exposure, navigation/permission denial,
dev URL origin, development-only CSP exceptions, relative build paths, strict
port handling, startup errors, owned dev process cleanup, and lockfile scope.
The pre-existing untracked `docs/PROJECT_SNAPSHOT.json` is preserved and excluded
from this implementation commit.

Hidden real Electron smoke tests exercise the same startup paths as the visible
commands. A human visual inspection of `npm run dev`/`npm start` and interactive
Ctrl+C remains unperformed. Windows process-tree enumeration was unavailable in
the restricted shell; port release was observed, but a full process-tree cleanup
audit is not claimed. Installer packaging and live n8n/Ollama integration remain
outside this issue.

## Official implementation references

- [Electron context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)
- [Electron security](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron sandbox](https://www.electronjs.org/docs/latest/tutorial/sandbox)
- [Vite guide](https://vite.dev/guide/)
- [Tailwind Vite plugin installation](https://tailwindcss.com/docs/installation/using-vite)

## Issue #3 managed Ollama lifecycle

Verified on Windows on 2026-11-20 with Node 24.22.3 and Electron 45.3.2.

| Check | Result |
| --- | --- |
| `node --test electron/sidecars.test.cjs` | Seven tests passed. A local HTTP fixture covers valid and invalid version responses and a hung request. Supervisor doubles cover external reuse, collision, delayed startup, timeout, missing executable, exit, recovery and repeated shutdown. |
| Windows Job Object test | A real PowerShell launcher started a Node child and grandchild. Both exited after control-pipe closure and after forced launcher termination. |
| `npm run build` | Production renderer build passed. |
| `npm run smoke` | Built Electron window passed with an independent HTTP fixture at `127.0.0.1:11434`. Electron reported external ownership, and the same fixture answered after Jarvis quit. |
| `npm run dev -- --smoke-test` | Development Electron window passed. The real Windows launcher reported missing-executable exit code 71 and shutdown finished. |

The Ollama executable was absent in the verification environment. Live startup
and cleanup with the Ollama binary and its model runners remain to be confirmed.
With Ollama installed, quit its tray application, launch Jarvis, wait for
`ready` with `owned` in the terminal, close Jarvis and verify the endpoint stops
responding. Repeat with Ollama already running and verify the endpoint still
responds after Jarvis quits.

The Windows launcher uses a [Job Object](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
for process-tree ownership and cleanup.

## Issue #4 managed n8n lifecycle

Verified on Windows on 2026-11-20 with Node 24.22.3 and Electron 45.3.2.

| Check | Result |
| --- | --- |
| `node --test electron/sidecars.test.cjs` | 10 passed. HTTP fixtures cover the pre-launch health probe, occupied port, external recovery and survival after shutdown. The Windows npm launcher fixture on a path with spaces verifies profile persistence and environment isolation. Shared supervisor tests cover startup timeout, unexpected exit, repeated shutdown and forced job cleanup. |
| `npm run build` | Passed. |
| `npm run smoke` and `npm run dev -- --smoke-test` | Both real Electron paths passed, including safe missing-n8n reporting and app shutdown. Chromium required the normal Windows desktop token for access to sandboxed renderer binaries. |
| Live n8n 2.48.7 on Windows | Passed with the repository's supervisor and an isolated npm install. Managed n8n reached readiness on a custom loopback port twice. A second supervisor detected the ready instance as external and stopping it left the endpoint healthy. Stopping the owner closed the endpoint. The SQLite profile and its generated encryption key persisted across restart. |

The managed install uses the
[n8n health and readiness routes](https://docs.n8n.io/hosting/logging-monitoring/monitoring/),
[deployment settings](https://docs.n8n.io/hosting/configuration/environment-variables/deployment/),
and an ephemeral task broker port supported by
[n8n 2.48.7](https://github.com/n8n-io/n8n/blob/n8n%402.48.7/packages/cli/src/task-runners/task-runner-module.ts).
Issue #5 tracks live sidebar status. Issue #9 tracks the production workflow.

## Issue #6: Prompt IPC and n8n bridge

Verified 2026-11-21 on Windows with Node 24.22.3 and Electron 45.3.2.

- `node --test electron/*.test.cjs` passed all 16 tests. The six new tests cover frame and input validation, port configuration, the POST contract, HTTP errors and redirects, malformed and oversized replies, header and body deadlines, and a dropped connection. They use loopback HTTP fixtures.
- `npm run build`, `npm run smoke`, and `npm run dev -- --smoke-test` passed. Both Electron smoke checks invoke `window.jarvis.sendPrompt` and verify the main-process validation envelope. The smoke commands ran outside the command sandbox to allow the Electron AppContainer to start.
- Composer wiring and a live n8n-to-Ollama reply depend on #7 and #9.

## Issue #7 composer and assistant replies

Verified on Windows on 2026-11-21. The issue branch was created after fetching
and pulling main at 0f9c658. It includes the pending chat shell and prompt
bridge prerequisites from draft PRs #14 and #18.

- `npm ci`, `npm run build`, and all 17 tests from `node --test electron/*.test.cjs` passed. Loopback fixtures cover both JSON reply shapes, malformed replies, and transport errors.
- Both Electron smoke commands passed. They exercise the real preload IPC validation, confirm Enter submits, check that modified Enter and IME Enter retain their default behavior, and confirm loading clears while the rejected draft remains editable.
- The successful reply path, retry after a network error, and switching chats during a pending request still need interactive verification. The live n8n and Ollama workflow is tracked in #9.
