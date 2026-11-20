const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const { createPromptHandler } = require('./prompt-bridge.cjs');

async function createChatSmokeFixture() {
  const requests = [];
  const reply = Promise.withResolvers();
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/webhook/jarvis-prompt') {
      response.writeHead(404).end();
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks)));
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (requests.length === 1) return; // Let the client deadline expire.
    if (requests.length === 2) await reply.promise;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ output: 'Jarvis smoke fixture reply' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    handler: (rendererUrl) => createPromptHandler(rendererUrl, {
      env: { JARVIS_N8N_PORT: String(server.address().port) },
      timeoutMs: 1500,
    }),
    async check(contents) {
      const runInComposer = (body) => contents.executeJavaScript(`(async () => {
        async function waitFor(predicate, description) {
          const deadline = Date.now() + 5000;
          while (!predicate()) {
            if (Date.now() >= deadline) throw new Error(description);
            await new Promise(resolve => setTimeout(resolve, 30));
          }
        }
        const input = document.querySelector('textarea');
        const prompt = 'Jarvis smoke fixture prompt';
        const replyText = 'Jarvis smoke fixture reply';
        ${body}
      })()`);
      await runInComposer(`
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, prompt);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await waitFor(() => !document.querySelector('.send-button').disabled, 'Composer did not accept the prompt');
        input.form.requestSubmit();
        input.form.requestSubmit();
        await waitFor(() => document.querySelector('[role=alert]')?.textContent.includes('took too long')
          && !document.querySelector('.pending'), 'Timeout did not clear loading or show an error');
        if (input.value !== prompt) throw new Error('Timeout lost the draft');
        input.form.requestSubmit();
        await waitFor(() => document.querySelector('.pending'), 'Retry did not enter loading state');
        document.querySelector('.new-chat').click();
        await waitFor(() => input.value === '' && !document.querySelector('.pending'), 'New conversation inherited the pending draft');
      `);
      reply.resolve();
      await runInComposer(`
        const findOrigin = () => [...document.querySelectorAll('.conversation-list button')]
          .find(button => button.textContent.trim() === prompt);
        await waitFor(findOrigin, 'Originating conversation did not receive its reply');
        if (document.querySelector('main').textContent.includes(replyText)) throw new Error('Reply appeared in the wrong conversation');
        findOrigin().click();
        await waitFor(() => document.querySelector('main').textContent.includes(replyText)
          && !document.querySelector('.pending'), 'Retry reply did not render');
        if (input.value || document.querySelector('[role=alert]')) throw new Error('Retry did not clear the composer');
      `);
      assert.equal(requests.length, 2);
      for (const { prompt, timestamp } of requests) {
        assert.equal(prompt, 'Jarvis smoke fixture prompt');
        assert.equal(new Date(timestamp).toISOString(), timestamp);
      }
    },
    close() {
      reply.resolve();
      return new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    },
  };
}

module.exports = { createChatSmokeFixture };
