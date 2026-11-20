# Jarvis local AI workflow

The workflow accepts `POST /webhook/jarvis-prompt` with a JSON body containing `prompt` and `timestamp`. The AI Agent reads `body.prompt`. The timestamp is accepted as request metadata. The response contains a single `output` string.

1. Start local Ollama and run `ollama pull llama3.2`. Confirm the model appears in `ollama list`.
2. In the n8n instance Jarvis will call, import [base_agent.json](../workflows/base_agent.json) using **Import from File**. The workflow targets n8n 2.48.7.
3. Open **Ollama Chat Model** and create or select an Ollama credential. For n8n and Ollama running as Windows host processes, set **Base URL** to `http://127.0.0.1:11434`. Leave the API key empty for the default local Ollama server. Select `llama3.2` or the same model configured for Jarvis readiness checks. [n8n Ollama credential documentation](https://docs.n8n.io/integrations/builtin/credentials/ollama/)
4. Save and **Publish** the workflow to register the production endpoint. The test path `/webhook-test/jarvis-prompt` is available while the Webhook node is listening for a test event. Jarvis uses the production path. [n8n Webhook documentation](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/)

For n8n in Docker Desktop with Ollama running on Windows, use `http://host.docker.internal:11434` and verify that Ollama listens on an address reachable from the container. When both services run in containers on the same user-defined network, use the Ollama service name, for example `http://ollama:11434`. Keep this webhook on the local n8n instance because the workflow uses an unauthenticated webhook. [Docker Desktop networking](https://docs.docker.com/desktop/features/networking/)

## Verify the production webhook

Run in PowerShell and substitute the n8n port if needed.

```powershell
$body = @{
    prompt = 'Reply with a short greeting.'
    timestamp = [DateTime]::UtcNow.ToString('o')
} | ConvertTo-Json -Compress

Invoke-RestMethod -Method Post `
    -Uri 'http://127.0.0.1:5678/webhook/jarvis-prompt' `
    -ContentType 'application/json' -Body $body -TimeoutSec 120
```

Expect HTTP 200 with JSON such as `{"output":"Hello!"}`. Send a prompt from Jarvis once its prompt bridge and composer are available. The reply should appear in the chat.

- For a webhook 404, check that the workflow is published in the same n8n instance and that the URL uses the production path.
- For an execution failure, check the Ollama credential URL and use `ollama list` to confirm the selected model is installed. Use the editor's test webhook to inspect node errors interactively. The workflow disables persistence of execution data by default.

## Verification record

On 2026-11-21, n8n 2.48.7 on Windows imported the workflow into an isolated profile. A copy with a local test credential was published. A loopback Ollama API fixture checked that the model request used `llama3.2` and contained the submitted prompt. The production webhook returned exactly one string field and preserved quotes and a newline. The idle test webhook returned 404.

Live model generation and the Electron round trip remain pending. Ollama was unavailable on the default loopback endpoint, and the app prerequisites are on separate issue branches.
