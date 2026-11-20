const { readN8nPort } = require('./n8n.cjs');

const MAX_PROMPT_LENGTH = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function failure(code, message, retryable = false) {
  return { success: false, error: { code, message, retryable } };
}

async function readResponse(body) {
  if (!body) return null;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parts = [];
  let bytes = 0;
  for await (const chunk of body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) return null;
    parts.push(decoder.decode(chunk, { stream: true }));
  }
  parts.push(decoder.decode());
  return JSON.parse(parts.join(''));
}

async function sendToN8n(url, prompt, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ prompt, timestamp: new Date().toISOString() }),
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.status === 404) {
      return failure('WEBHOOK_NOT_FOUND', 'Activate the jarvis-prompt workflow in n8n, then retry.', true);
    }
    if (!response.ok) {
      return failure('WEBHOOK_HTTP_ERROR', `n8n returned HTTP ${response.status}. Check the webhook and workflow execution in n8n.`,
        response.status >= 500 || response.status === 429);
    }

    const result = await readResponse(response.body);
    if (typeof result?.output === 'string' && result.output.trim()) {
      return { success: true, data: { output: result.output } };
    }
    return failure('INVALID_RESPONSE', 'Configure the n8n webhook to return a JSON object with a non-empty output string.');
  } catch (error) {
    if (controller.signal.aborted) {
      return failure('WEBHOOK_TIMEOUT', 'n8n took too long to respond. Check the workflow execution before retrying.', true);
    }
    if (error instanceof SyntaxError || error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') {
      return failure('INVALID_RESPONSE', 'Configure the n8n webhook to return valid UTF-8 JSON.');
    }
    return failure('N8N_UNAVAILABLE', 'Could not complete the request to local n8n. Check that n8n is running and try again.', true);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function createPromptHandler(rendererUrl, { env = process.env, timeoutMs = 120_000 } = {}) {
  const port = readN8nPort(env);
  const url = `http://127.0.0.1:${port}/webhook/jarvis-prompt`;
  return (event, input) => {
    const frame = event.senderFrame;
    if (!frame || frame.parent !== null || frame.url !== rendererUrl) {
      return failure('UNTRUSTED_SENDER', 'This window cannot send prompts.');
    }
    const prompt = typeof input === 'string' ? input.trim() : '';
    if (!prompt || prompt.length > MAX_PROMPT_LENGTH) {
      return failure('INVALID_PROMPT', `Enter a prompt between 1 and ${MAX_PROMPT_LENGTH} characters.`);
    }
    if (port === null) {
      return failure('INVALID_N8N_PORT', 'Set JARVIS_N8N_PORT to a port from 1 to 65535 and restart Jarvis.');
    }
    return sendToN8n(url, prompt, timeoutMs);
  };
}

module.exports = { createPromptHandler };
