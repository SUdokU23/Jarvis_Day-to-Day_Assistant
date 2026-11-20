# Jarvis Day-to-Day Assistant

## Set up the local n8n workflow

1. Install [Ollama for Windows](https://ollama.com/download/windows) and run `ollama pull llama3.2`. Check the installed model with `ollama list`.
2. Use n8n 2.48.7, the version used to verify this export. See the [n8n npm installation guide](https://docs.n8n.io/deploy/host-n8n/install-options/install-with-npm.md). Open the editor at `http://127.0.0.1:5678` by default. With the Jarvis desktop runtime, import into the n8n instance listening on `JARVIS_N8N_PORT` (default `5678`). Jarvis reuses a healthy external instance on that port. When Jarvis starts n8n itself, it uses a separate persistent profile, so import and configure the workflow in that profile.
3. In the n8n editor, select **Import from File** and choose [workflows/base_agent.json](workflows/base_agent.json). In **Ollama Chat Model**, create or select an Ollama credential with base URL `http://127.0.0.1:11434`. Leave the API key empty for local Ollama. Select `llama3.2`, or select the same installed model as `JARVIS_OLLAMA_MODEL` if you configure that setting. [n8n Ollama credential guide](https://docs.n8n.io/integrations/builtin/credentials/ollama)
4. Save and **Publish** the workflow. Jarvis sends requests to `POST http://127.0.0.1:5678/webhook/jarvis-prompt` using the configured n8n port. Keep this unauthenticated webhook on loopback. The editor's `/webhook-test/jarvis-prompt` endpoint is for testing while the Webhook node is listening.

The production webhook accepts JSON with a `prompt` string and an ISO 8601 `timestamp`. The AI Agent reads `body.prompt` and returns HTTP 200 with JSON such as `{"output":"Hello!"}`. Jarvis displays the non-empty `output` string in chat. See the [PowerShell smoke check and troubleshooting](docs/N8N_WORKFLOW.md#verify-the-production-webhook).

The shared workflow is inactive and contains no credential references or pinned execution data. When updating the export, remove any credential references, authentication headers, instance-specific configuration, and private sample data before committing. [n8n export and import guide](https://docs.n8n.io/build/manage-workflows/export-and-import.md)

## Issue delivery

For each issue, recheck the live requirements, run `git fetch origin`, switch to local `main`, and run `git pull --ff-only origin main`. Create a fresh issue branch from that updated tip, implement and verify the change, push the branch, and open a draft pull request targeting `main`.
