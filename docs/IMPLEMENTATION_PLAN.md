# Jarvis backlog implementation plan

Prepared 2026-11-14, Europe/Sofia. Updated 2026-11-20. Issues #1 and #2 are implemented on issue branches. See VERIFICATION.md for checks and remaining limits.

## Evidence and scope

Source board: [Jarvis project 3, Backlog view](https://github.com/users/SUdokU23/projects/3/views/1). Its embedded project data reports exactly 12 items, all Backlog, all open repository issues #1–#12. Both group and item pagination report no next page. Other status groups are empty. No assignees, size, estimate, or project priority values are populated. P0/P1 below are taken from issue descriptions, not populated project fields.

All 12 issue bodies, acceptance checklists, and dependencies were inspected through the connected GitHub issue search. The local repository was cloned empty. The workspace architecture specification describes a larger product; this plan implements the actual current backlog and records future scope separately.

Milestone outcome: `npm run dev` starts a Windows Electron app, displays n8n/Ollama health, sends a prompt securely through n8n to a local model, displays its reply, and exits without terminating external services or leaving owned child processes running.

## Technical approach and proposed structure

Use Electron main for trusted runtime/configuration, a narrow preload bridge, and React/Vite for rendering. Use Tailwind through the supported integration of the selected version; lock dependency versions after checking compatibility. Use host processes for n8n and Ollama initially, avoiding container hostname complexity. Verify current official Electron, Vite, Tailwind, n8n, and Ollama documentation during implementation before selecting versions, environment variables, workflow node versions, or packaging configuration.

Proposed files (not existing implementation):

```text
electron/main.js             application lifecycle and secure BrowserWindow
electron/preload.js          allowlisted contextBridge API
electron/config.js           validated trusted configuration
electron/sidecars.js         service ownership, health, startup, shutdown
electron/prompt-bridge.js    prompt validation and bounded n8n HTTP call
src/App.jsx                  conversation state and overall shell
src/components/Sidebar.jsx   conversations, settings entry, health badges
src/components/ChatInput.jsx expanding composer and send interaction
src/components/ChatHistory.jsx safe Markdown message rendering
src/styles.css               responsive theme and Tailwind entry
workflows/base_agent.json     sanitized importable n8n workflow
docs/SMOKE_TESTS.md           Windows verification procedure and evidence
README.md                    development/runtime/workflow setup
.env.example                 documented non-secret configuration examples
```

Suggested contracts to establish in #1/#6:

- `sendPrompt(prompt)` returns `{success:true,data:{output:string}}` or `{success:false,error:{code,message,retryable}}`; UI never receives raw stack traces.
- n8n production request: `POST /webhook/jarvis-prompt`, JSON `{prompt,timestamp}` with timestamp generated in main. Response: `{output:string}`.
- `getServiceStatus()` supplies a snapshot; `onServiceStatus(callback)` returns an unsubscribe function. Service status contains service ID, state, ownership, safe diagnostic code, and model readiness where relevant.
- Public service states: `starting`, `ready`, `failed`, `stopped`. Translate the `error` terminology in #3 into `failed` consistently; keep missing model distinct from unreachable server.
- Proposed defaults: 10,000-character prompt limit, 2-second health request timeout, 60-second startup deadline, 120-second generation deadline. These are planning choices to validate against local hardware, not existing requirements or measured performance.
- Runtime configuration is main-process owned: executable paths, loopback endpoints/ports, model name, deadlines, isolated n8n data directory. Renderer cannot choose arbitrary URLs, executable paths, IPC channels, or commands.

## Delivery sequence

| Stage | Issues | Deliverable / exit gate |
| --- | --- | --- |
| A | #1 | Secure desktop scaffold starts in development and loads a built renderer |
| B | #2, then #3 and #4 | Usable shell and reliable runtime ownership/health management |
| C | #5, #6, #8 | Live status, validated prompt bridge, distinct model readiness |
| D | #7, #9 | Prompt-to-local-model round trip with recoverable UI errors |
| E | #10, #12 | Reproducible workflow setup and completed security review |
| F | #11 | Windows integration evidence, cleanup checks, milestone sign-off |

Some tasks are independent once dependencies pass, but no parallel agents are assumed. Apply #12 safeguards from Stage A; final security validation precedes #11 sign-off. Although #9 only declares #4/#8 dependencies, validate its HTTP contract against #6. #11 explicitly depends on #5/#7/#9/#10; also require #12 for release readiness.

## Per-item implementation and acceptance plan

### W1-01 / [#1: Electron + React + Vite + Tailwind](https://github.com/SUdokU23/Jarvis_Day-to-Day_Assistant/issues/1)

Priority P0. Dependencies: none. Proposed size M.

1. Initialize package metadata, Electron main/preload, React renderer, Vite, supported Tailwind integration, and ignore rules. Preserve this planning document.
2. Provide install, dev, renderer build, and Electron start scripts. Start Electron only after Vite is ready, use one configured strict dev port, and clean up the dev runner on exit.
3. Configure `contextIsolation: true`, `nodeIntegration: false`, and sandbox compatibility from the start. Development uses the configured Vite origin; packaged mode loads built renderer assets with compatible asset paths.
4. Document prerequisites, scripts, runtime installation boundaries, and non-secret configuration in README/.env.example.

Verification: clean install; `npm run dev` opens the styled window; production renderer build succeeds and loads without a running Vite server; no port mismatch; renderer has no Node access. Record selected compatible versions and commit lockfile when implementation is committed.

### W1-02 / [#2: Responsive chat shell](https://github.com/SUdokU23/Jarvis_Day-to-Day_Assistant/issues/2)

Priority P1. Dependencies: #1. Proposed size M.

1. Build a resizable sidebar with conversation list, runtime badges, and settings entry; support a collapsed layout at narrow window widths.
2. Add scrollable history, distinct user/assistant messages, empty/loading/error presentations, keyboard focus, accessible labels, and expanding composer.
3. Use lucide-react icons and a Markdown renderer with raw HTML disabled and safe URL handling. Keep microphone visibly disabled with a coming-soon explanation.

Verification: manual wide/narrow/resized window checks; long messages and code blocks remain usable; keyboard navigation works; hostile Markdown cannot execute scripts or navigate to unsafe protocols. No speech feature is implied by the microphone placeholder.

### W1-03 / [#3: Managed Ollama lifecycle](https://github.com/SUdokU23/Jarvis_Day-to-Day_Assistant/issues/3)

Priority P0. Dependencies: #1. Proposed size L.

1. Implement a reusable service supervisor with explicit owned/external state. Probe `http://127.0.0.1:11434/api/version` before spawning; a healthy existing service is external.
2. Spawn the configured executable without a shell where feasible, with hidden Windows background windows. Handle spawn errors, unexpected exits, bounded retries, and request timeouts; capture safe diagnostics without prompts/secrets.
3. Publish state transitions and periodically detect crashes/recovery. Prevent duplicate starts and make shutdown idempotent.
4. Terminate only tracked owned processes/trees on quit, including startup-in-progress; never kill by image name or merely by occupied port.

Verification: supervisor tests for healthy external service, delayed readiness, absent executable, timeout, crash, recovery, and repeated shutdown; Windows manual process-tree test proves owned children exit and external Ollama survives. Server health is independent from model readiness (#8).

### W1-04 / [#4: Managed n8n lifecycle](https://github.com/SUdokU23/Jarvis_Day-to-Day_Assistant/issues/4)

Priority P0. Dependencies: #1. Proposed size L.

1. Reuse the supervisor with configured n8n executable/port and initial `/healthz` probe at `127.0.0.1:5678`.
2. Distinguish a healthy external n8n from an unrelated process occupying its port; report collisions without taking ownership.
3. Use an app-specific writable user-data directory and supported n8n configuration. Keep local credential encryption material out of source/logs. Verify current authentication, CLI and environment behavior rather than copying obsolete flags.
4. Implement bounded startup, crash diagnostics, and Windows owned-process-tree cleanup. Choose a supported Windows launcher strategy if n8n is distributed as a `.cmd` shim; never interpolate renderer input into a command line.

Verification: missing executable, occupied port, unhealthy startup, persistent isolated data, external-instance reuse, and owned/external shutdown tests. A healthy server does not imply that the production workflow is activated; report webhook failures separately.

### W1-05 / [#5: Live sidebar health](https://github.com/SUdokU23/Jarvis_Day-to-Day_Assistant/issues/5)

Priority P1. Dependencies: #2, #3, #4. Proposed size S.

1. Publish sanitized service events through main/preload and expose an initial snapshot request.
2. Subscribe before requesting the initial snapshot, with a revision or equivalent ordering guard so stale snapshots cannot overwrite newer events.
3. Render starting/ready/failed/stopped badges and actionable safe failure text. Clean up listeners on component unmount and reflect later recovery.

Verification: late subscription still shows correct status; crash/recovery updates badges; remount does not duplicate listeners; renderer receives neither raw IPC event objects nor privileged Electron APIs.

### W1-06 / [#6: Prompt IPC and n8n bridge](https://github.com/SUdokU23/Jarvis_Day-to-Day_Assistant/issues/6)

Priority P0. Dependencies: #1, #4. Proposed size M.

1. Register only the `send-prompt` handler; validate trusted sender, string type, trimmed non-empty content, and configured maximum length in main.
2. POST `{prompt,timestamp}` to the main-owned production webhook URL using an abortable timeout. Bound response handling and normalize the expected output.
3. Return a stable success/error envelope for validation, unavailable service, HTTP failure, timeout, invalid JSON, and malformed response. Log safe error metadata only.

Verification: boundary tests for invalid types/whitespace/length; mocked HTTP timeout/non-2xx/invalid payload; valid response normalization; untrusted sender and renderer-supplied URL cannot bypass controls. Use one normalization rule shared with #7 rather than inconsistent parsing in multiple layers.

### W1-07 / [#7: Composer and replies](https://github.com/SUdokU23/Jarvis_Day-to-Day_Assistant/issues/7)

Priority P1. Dependencies: #2, #6. Proposed size M.

1. Implement Enter-to-send, Shift+Enter newline, composition-event handling, and an immediate in-flight guard against duplicate sends.
2. Capture conversation and request IDs before awaiting the bridge; append replies to the originating conversation even if the user switches chats.
3. Reset loading in `finally`. Keep failed prompt text available for editing/retry without duplicating history entries; show actionable errors.
4. Render normalized output safely; handle supported string/object legacy payloads at the agreed normalization boundary, reject unsupported objects rather than rendering `[object Object]`.

Verification: duplicate-send, failure/retry, loading cleanup, conversation switch during request, multiline input, IME composition, and response-shape tests. Complete the actual live round trip after #9.

### W1-08 / [#8: Local model and readiness](https://github.com/SUdokU23/Jarvis_Day-to-Day_Assistant/issues/8)

Priority P0. Dependencies: #3. Proposed size S.

1. Document Ollama installation, `ollama pull llama3.2`, model listing, and a local invocation command; explain disk/memory needs after choosing the actual model variant.
2. Query the supported local model inventory API and check the configurable model identifier, accounting for canonical tags.
3. Distinguish server unavailable, model absent, and invocation failure; give model download instructions rather than silently initiating a large download.
4. Align configured model name with workflow setup so the UI cannot report readiness for one model while n8n uses another.

Verification: model-present/missing/unreachable cases; locally generated answer without cloud credentials; changing model configuration changes readiness and documented n8n selection. Do not assume a sub-second response on unknown hardware.

### W1-09 / [#9: n8n local AI workflow](https://github.com/SUdokU23/Jarvis_Day-to-Day_Assistant/issues/9)

Priority P0. Dependencies: #4, #8. Proposed size M.

1. Create POST Webhook `jarvis-prompt` → AI Agent with attached Ollama Chat Model → Respond to Webhook, using node versions supported by the selected n8n release.
2. Explicitly map `{{$json.body.prompt}}` to agent input, configure the local host/model, and map output to `{output:string}`. Keep this base workflow free of Gmail, browsing, filesystem and shell tools.
3. Use host loopback for the initial host-process topology. Document container-specific hostname differences as an alternative, not as the default.
4. Activate the production webhook and distinguish `/webhook/` from temporary `/webhook-test/`. Resolve any installed-version agent requirements before declaring the workflow importable.

Verification: direct POST with `{prompt,timestamp}` produces JSON output; missing model/unavailable Ollama fails intelligibly; full Electron path works; inactive/test-only workflows are diagnosed rather than mistaken for n8n server failure.

### W1-10 / [#10: Reusable workflow and documentation](https://github.com/SUdokU23/Jarvis_Day-to-Day_Assistant/issues/10)

Priority P1. Dependencies: #9. Proposed size S.

1. Export `workflows/base_agent.json` with compatible node schema and no credentials, tokens, execution history, pinned private data, or machine-specific secrets.
2. Document installation, import, credential setup if required by the selected node, model selection, activation, exact local endpoints, example request/response, and troubleshooting.
3. Explain how a reused external n8n instance is configured manually and how it differs from app-owned runtime data.

Verification: import into a clean, isolated n8n profile; configure local model; activate and run a direct POST followed by an app prompt. Inspect exported JSON for secrets and check contract matches #6/#9.

### W1-11 / [#11: Windows integration and shutdown verification](https://github.com/SUdokU23/Jarvis_Day-to-Day_Assistant/issues/11)

Priority P0. Dependencies: #5, #7, #9, #10; final gate also requires #12. Proposed size M.

1. Write `docs/SMOKE_TESTS.md` with prerequisites, exact commands, environment versions, expected outcomes, actual results, and cleanup observations.
2. Verify `npm run dev`, owned startup, ready badges, full renderer → IPC → n8n → Ollama → n8n → renderer path, and clean quit.
3. Exercise missing executable, failed service, missing model, inactive workflow, invalid response, and webhook timeout; confirm recoverable errors preserve user input.
4. Run owned-only, external-only, and mixed-ownership scenarios. Inspect Windows process trees before/after exit, including immediate quit during startup; prove independent services survive.
5. Add focused automated supervisor, bridge, and conversation race tests plus a deterministic integration fixture where useful. Keep real n8n/Ollama tests explicitly separate from mocks.

Acceptance evidence: every issue checklist mapped to passing evidence; no claim that an unrun Windows/hardware integration check passed. Record blockers and exact reproduction if local prerequisites prevent any case.

### W1-12 / [#12: Security and configuration hardening](https://github.com/SUdokU23/Jarvis_Day-to-Day_Assistant/issues/12)

Priority P0. Dependencies: #1, #6. Proposed size M.

1. Restrict navigation, window opening, privileged IPC senders, and exposed preload methods. Validate every privileged input and deny unexpected origins/channels.
2. Enforce context isolation, disabled Node integration, compatible sandboxing, safe Markdown/link behavior, and separate development/production CSP suitable for each loading mode.
3. Load built assets in packaged mode; bind managed services to loopback where supported and validate configured hosts. Document n8n authentication and workflow administration separately from the app's no-login UX.
4. Keep runtime secrets in local protected runtime storage, redact logs, ignore local data/config/secrets, and review workflow exports. Select any local webhook authentication supported by the installed version without exposing its secret to the renderer.
5. Verify supported configuration and feature availability in official version-matched docs. Do not disable n8n security using obsolete or unverified environment flags.

Verification: rejected navigation/window opening/unsafe URLs/untrusted IPC; inspected dev/prod CSP and BrowserWindow options; configured loopback bindings; no secret or prompt content in source/default logs; production renderer starts without Vite. Perform safeguards early and final audit before #11.

## Completion tracking and estimates

Issue #1 is implemented on `feat/1-desktop-scaffold`, pending PR review and human visual/interactive checks; see [verification evidence](VERIFICATION.md). The live issue was rechecked before implementation. An initial documentation-only commit bootstrapped the empty remote `main`; the issue branch was created after fetching and pulling it. Issue #2 is implemented on `feat/2-responsive-chat-shell`; see [chat shell verification](VERIFICATION.md#issue-2-responsive-chat-shell). Issues #3–#12 remain **not started**. Suggested sizes are relative planning judgments, not GitHub field values or time commitments. Runtime lifecycle and Windows cleanup are the highest uncertainty. The W1 prefix is the source milestone label, not evidence this can be completed within a calendar week.

For each implemented issue, record its files/commit, checks run and outcomes, unresolved limitations, and any approved change in scope here or in linked verification records. After confirming a PR is merged, move its linked issue to In Review on the Jarvis project board. A finished milestone requires all 12 issue acceptance checklists and a working clean-profile setup, not merely mocked tests or a successful renderer build.

## Broader architecture follow-up, outside these 12 items

- Gmail OAuth and read/query workflows, with explicit permission scope and local encrypted credential handling.
- Web search, domain filters, retrieval/summarization, and source links, with provider feasibility checked before choosing scraping.
- Local faster-whisper recording/transcription, microphone permissions, hardware benchmarks, and model distribution.
- Two-step summary export to `.docx` or `.txt`, safe destination handling, and controlled Notepad launch.
- Installer, runtime/model distribution strategy, update/uninstall behavior, and production packaging validation.
- Durable conversation/settings storage and retention policy if required; the current issues do not specify persistence.

These need their own issues and acceptance criteria before being treated as committed implementation scope. The architecture mentions `/webhook/prompt`; current #6/#9 explicitly specify `/webhook/jarvis-prompt`, which this milestone uses.

## Resume instructions

Read workspace `AGENTS.md` and `MEMORY.md`, recheck the live issue and any dependency PRs before starting the next issue. Always fetch/pull latest `main`, branch from it for each issue, verify, and prepare a PR targeting `main`. Preserve the root architecture specification. Do not begin Gmail/search/voice/export work by inferring it from placeholders. Keep main/preload security and owned/external runtime separation intact throughout.
