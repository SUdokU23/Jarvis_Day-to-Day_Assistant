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
