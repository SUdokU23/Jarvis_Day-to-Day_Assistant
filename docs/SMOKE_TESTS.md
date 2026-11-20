# Windows integration smoke tests

Issue #11 was exercised on 2026-11-21 using Windows 10.0.26300, Node 24.22.3,
npm 11.19.1, Electron 45.3.2, and n8n 2.48.7. Ollama and the local model were
unavailable in the test environment.

## Automated checks

Run from the repository root in a Windows PowerShell session that can launch
Electron's sandboxed renderer.

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm.cmd ci
node --test electron/*.test.cjs
npm.cmd run build
npm.cmd run smoke
npm.cmd run dev -- --smoke-test
```

The 17 Node tests, production build, and both Electron smoke commands passed
with the existing workspace dependencies. The smoke commands start a hidden
window and print `SMOKE PASS` before quitting. They use a local HTTP fixture for
the production webhook path and a controlled Ollama health probe. They check
renderer startup, IPC validation, health transitions, timeout feedback, draft
retention, duplicate submission prevention, and reply routing after switching
conversations during a retry.

The Node suite covers unavailable and malformed webhook responses, inactive
webhooks, bounded timeouts, missing sidecar executables, external service
survival, quit during startup, and Windows Job Object descendant cleanup.

An additional Electron smoke run used an installed n8n 2.48.7 shim on port
15678. The log showed n8n starting with `ownership: 'owned'`, followed by a
launcher exit code of 0 and a stopped state on quit during startup. The run
finished before n8n reached readiness.

## Live manual checks

Use a Windows test account or a dedicated test profile, with free loopback
ports and n8n and Ollama installed. Prepare the production workflow following
the [workflow setup](N8N_WORKFLOW.md). Publish it in the actual n8n profile used
for each run. Open a second PowerShell console for probes.

```powershell
Get-Command ollama,n8n.cmd
ollama pull llama3.2
ollama list
npm.cmd run dev
```

1. **Owned services.** Start with ports 5678 and 11434 free. Wait for both
   sidebar badges to show Ready and for the terminal to report owned services.
   Send a short prompt. Expect a rendered reply in the same conversation. Check
   the workflow directly with the POST command in the workflow setup.
2. **Recoverable failures.** On the test profile, unpublish the workflow and
   submit a prompt. Expect activation guidance and an editable draft. Publish it
   again and retry. Temporarily select a model that is absent from `ollama list`
   in the workflow, submit, and confirm the failure is visible and the draft is
   retained. Restore the configured model and retry. For a timeout, use a
   disposable workflow that accepts the production path and waits more than
   120 seconds before responding. Expect a timeout message and cleared loading.
   Repeat with an invalid output shape and confirm response-format guidance.
3. **Shutdown ownership.** Record listening process IDs and their child trees
   before closing the app window. Repeat with both services started independently,
   with either service started independently, and by closing the app during
   owned startup. Owned process IDs and descendants should disappear. Independent
   listeners should retain their process IDs and continue answering health probes.

```powershell
$listeners = Get-NetTCPConnection -State Listen -LocalPort 5678,11434 -ErrorAction SilentlyContinue
$listeners | Select-Object LocalAddress,LocalPort,OwningProcess
Get-CimInstance Win32_Process | Select-Object Name,ProcessId,ParentProcessId
Invoke-RestMethod http://127.0.0.1:5678/healthz/readiness -TimeoutSec 5
Invoke-RestMethod http://127.0.0.1:11434/api/version -TimeoutSec 5
```

Save the process snapshot before and after closing the app and match descendants
using `ParentProcessId`. Stop only the independently started test processes
using their original consoles after recording the results.

| Issue #11 criterion | Result |
| --- | --- |
| Development app opens | Hidden Vite-backed Electron smoke passed. Visible interactive check pending. |
| Both owned services start and show Ready | Controlled badge transitions passed. Live two-service readiness pending. |
| Renderer → IPC → n8n → Ollama → n8n → renderer | Real renderer and IPC passed against the HTTP fixture. The separate n8n workflow check used an Ollama API fixture. Live end-to-end generation pending. |
| Failed services, absent model, and timeout are recoverable | Failed service badge and composer timeout/retry passed. Inactive workflow and invalid replies passed at the bridge. Live absent-model failure pending. |
| Quit closes only owned processes without orphans | Windows Job Object fixture and owned n8n quit during startup passed. Live two-service process snapshots pending. |
| Independent services survive quit | External loopback fixtures survived supervisor stop. Live external-only and mixed ownership pending. |
| Document commands and outcomes | Recorded here. |

Final acceptance also depends on the separate issue #12 hardening gate.
