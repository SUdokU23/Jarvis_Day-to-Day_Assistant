const { app, BrowserWindow, dialog, ipcMain, session } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { OllamaSidecar } = require('./sidecars.js');

const { createN8nSidecar } = require('./n8n.cjs');
const { createPromptHandler } = require('./prompt-bridge.cjs');
const { createChatSmokeFixture } = require('./chat-smoke.cjs');

const smoke = process.argv.includes('--smoke-test');
const smokeOllamaStartup = smoke ? Promise.withResolvers() : null;
let smokeOllamaHealth = 'ready';
const ollama = new OllamaSidecar(smoke ? {
  probe: async () => {
    await smokeOllamaStartup.promise;
    return smokeOllamaHealth;
  },
  monitorIntervalMs: 100,
} : undefined);
const sidecars = [ollama, createN8nSidecar(app.getPath('userData'))];
const windows = new Set();
let statusRevision = 0;
let quitting = false;
let cleanupComplete = false;

function serviceSnapshot() {
  return {
    revision: statusRevision,
    services: sidecars.map(({ status: { service, state, code } }) => ({ service, state, code })),
  };
}

for (const sidecar of sidecars) {
  const label = `[${sidecar.status.service}]`;
  sidecar.on('status', (status) => {
    console.info(label, status);
    statusRevision += 1;
    const snapshot = serviceSnapshot();
    for (const window of windows) {
      const contents = window.webContents;
      if (!contents.isDestroyed() && contents.getURL() === rendererUrl) {
        contents.send('service-status:changed', snapshot);
      }
    }
  });
  sidecar.on('diagnostic', (diagnostic) => console.info(label, diagnostic));
}

function stopSidecars() {
  smokeOllamaStartup?.resolve();
  return Promise.all(sidecars.map((sidecar) => sidecar.stop()));
}
const devUrl = !app.isPackaged && process.env.JARVIS_DEV_URL;
const builtPage = path.join(__dirname, '../dist/index.html');
const builtUrl = pathToFileURL(builtPage).href;

if (devUrl) {
  const url = new URL(devUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
      || url.href !== `${url.origin}/`) {
    throw new Error('Development renderer must use the loopback Vite server.');
  }
}
const rendererUrl = devUrl ? new URL(devUrl).href : builtUrl;

ipcMain.handle('service-status:get', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!windows.has(window) || event.senderFrame !== event.sender.mainFrame
      || event.senderFrame?.url !== rendererUrl) {
    throw new Error('Service status is unavailable to this frame.');
  }
  return serviceSnapshot();
});

async function checkServiceStatus(window) {
  const contents = window.webContents;
  const waitForBadge = (state) => contents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    function check() {
      const badge = document.querySelector('[data-service=ollama] .badge');
      const matches = badge?.dataset.state === ${JSON.stringify(state)};
      if (matches && (${JSON.stringify(state)} !== 'failed' || badge.parentElement.querySelector('small')?.textContent)) resolve();
      else if (Date.now() >= deadline) reject(new Error('Ollama badge did not reach ${state}'));
      else setTimeout(check, 25);
    }
    check();
  })`);

  await waitForBadge('stopped');
  ollama.start();
  await waitForBadge('starting');
  smokeOllamaStartup.resolve();
  await waitForBadge('ready');

  const lateSnapshot = await contents.executeJavaScript('window.jarvis.getServiceStatus()');
  if (lateSnapshot.services.length !== 2
      || lateSnapshot.services.find(({ service }) => service === 'ollama')?.state !== 'ready') {
    throw new Error('Late service snapshot is missing the current status');
  }

  await contents.executeJavaScript(`(() => {
    window.statusSmoke = { removedCalls: 0, received: [] };
    window.jarvis.onServiceStatus(() => window.statusSmoke.removedCalls++)();
    window.statusSmoke.unsubscribe = window.jarvis.onServiceStatus((...args) => {
      window.statusSmoke.received.push({ count: args.length, snapshot: args[0] });
    });
  })()`);
  smokeOllamaHealth = 'absent';
  await waitForBadge('failed');
  smokeOllamaHealth = 'ready';
  await waitForBadge('ready');
  await contents.executeJavaScript(`new Promise((resolve, reject) => {
    document.querySelector('aside [aria-label="Hide sidebar"]').click();
    requestAnimationFrame(() => {
      if (document.querySelector('aside')) return reject(new Error('Sidebar did not close'));
      document.querySelector('[aria-label="Show sidebar"]').click();
      resolve();
    });
  })`);
  await waitForBadge('ready');
  await ollama.stop();
  await waitForBadge('stopped');

  const events = await contents.executeJavaScript(`(() => {
    const { removedCalls, received, unsubscribe } = window.statusSmoke;
    unsubscribe();
    delete window.statusSmoke;
    return { removedCalls, received };
  })()`);
  const states = events.received.map(({ snapshot }) =>
    snapshot.services.find(({ service }) => service === 'ollama').state);
  if (events.removedCalls || events.received.some(({ count }) => count !== 1)
      || !['failed', 'ready', 'stopped'].every((state) => states.includes(state))) {
    throw new Error('Status event payload or unsubscribe check failed');
  }
}

async function createWindow() {
  const window = new BrowserWindow({
    width: 1100, height: 760, minWidth: 480, minHeight: 400,
    backgroundColor: '#141716', show: !smoke,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-frame-navigate', (event) => event.preventDefault());
  window.webContents.on('will-redirect', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  windows.add(window);
  window.once('closed', () => windows.delete(window));
  const fixture = smoke ? await createChatSmokeFixture() : null;
  try {
    window.webContents.ipc.handle('send-prompt', fixture?.handler(rendererUrl) ?? createPromptHandler(rendererUrl));
    if (devUrl) await window.loadURL(rendererUrl);
    else await window.loadFile(builtPage);
    if (fixture) await runSmoke(window, fixture);
  } finally {
    await fixture?.close();
  }
  if (smoke) app.quit();
}

async function runSmoke(window, fixture) {
    const result = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      function check() {
        const main = document.querySelector('main');
        if (main && window.jarvis) {
          resolve({ heading: document.querySelector('h1')?.textContent,
            node: typeof require, process: typeof process,
            platform: window.jarvis.platform, background: getComputedStyle(document.documentElement).backgroundColor });
        } else if (Date.now() > deadline) reject(new Error('Renderer or preload did not initialize'));
        else setTimeout(check, 50);
      }
      check();
    })`);
    const invalidPrompt = await window.webContents.executeJavaScript("window.jarvis.sendPrompt('  ')");
    const security = await window.webContents.executeJavaScript(`(() => {
      const script = document.createElement('script');
      script.textContent = 'window.jarvisInlineScriptRan = true';
      document.head.append(script);
      script.remove();
      return {
        inlineScriptRan: window.jarvisInlineScriptRan === true,
        popupDenied: window.open('about:blank') === null,
        bridgeKeys: Object.keys(window.jarvis).sort().join(','),
      };
    })()`);
    if (security.inlineScriptRan !== Boolean(devUrl) || !security.popupDenied
        || security.bridgeKeys !== 'getServiceStatus,onServiceStatus,platform,sendPrompt') {
      throw new Error('Renderer CSP, popup denial or preload surface check failed.');
    }
    const preferences = window.webContents.getLastWebPreferences();
    if (result.heading !== 'How can I help?' || result.node !== 'undefined' || result.process !== 'undefined'
        || result.background === 'rgba(0, 0, 0, 0)' || !preferences.contextIsolation
        || preferences.nodeIntegration || !preferences.sandbox
        || invalidPrompt.success !== false || invalidPrompt.error?.code !== 'INVALID_PROMPT') {
      throw new Error(`Smoke check failed: ${JSON.stringify(result)}`);
    }
    const shell = await window.webContents.executeJavaScript(String.raw`new Promise((resolve, reject) => {
      const input = document.querySelector('textarea');
      const resize = document.querySelector('[role=separator]');
      const sidebar = document.querySelector('aside');
      const badgeCount = sidebar.querySelectorAll('.badge').length;
      const microphoneDisabled = document.querySelector('[aria-label^=Microphone]').disabled;
      resize.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      requestAnimationFrame(() => {
        const resized = resize.getAttribute('aria-valuenow') === '296';
        const initialHeight = input.clientHeight;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Hello Jarvis\nSecond line\n' + 'x'.repeat(10_000));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        requestAnimationFrame(() => {
          const expanded = input.clientHeight > initialHeight;
          const key = (shiftKey) => new KeyboardEvent('keydown', { key: 'Enter', shiftKey, bubbles: true, cancelable: true });
          const composing = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
          const shiftPreserved = input.dispatchEvent(key(true));
          const compositionPreserved = input.dispatchEvent(composing);
          const enterSent = !input.dispatchEvent(key(false));
          const deadline = Date.now() + 3000;
          function checkError() {
            const error = document.querySelector('[role=alert]');
            if (error?.textContent.includes('between 1 and 10000') && !document.querySelector('.pending')) {
              resolve({ resized, expanded, badgeCount, microphoneDisabled, shiftPreserved, compositionPreserved, enterSent, draftPreserved: input.value.startsWith('Hello Jarvis') });
            } else if (Date.now() > deadline) reject(new Error('Expected validation error and loading cleanup'));
            else requestAnimationFrame(checkError);
          }
          checkError();
        });
      });
    })`);
    if (!shell.resized || !shell.expanded || shell.badgeCount !== 2 || !shell.microphoneDisabled || !shell.draftPreserved || !shell.shiftPreserved || !shell.compositionPreserved || !shell.enterSent) {
      throw new Error(`Chat shell smoke check failed: ${JSON.stringify(shell)}`);
    }
    await checkServiceStatus(window);
    await fixture.check(window.webContents);
    window.setContentSize(600, 500);
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 3000;
      function check() {
        if (window.innerWidth <= 720 && !document.querySelector('aside')) {
          resolve();
        } else if (Date.now() > deadline) reject(new Error('Sidebar did not collapse at 600px'));
        else requestAnimationFrame(check);
      }
      check();
    })`);
    console.log('SMOKE PASS', JSON.stringify({ ...result, ...shell, liveServiceStatus: true, narrowSidebarCollapsed: true, webhookTimeoutAndRetry: true }));
}

app.whenReady().then(async () => {
  if (quitting) return;
  for (const sidecar of sidecars) {
    if (!smoke || sidecar !== ollama) sidecar.start();
  }
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.on('will-download', (event) => event.preventDefault());
  if (devUrl) {
    const origin = new URL(devUrl).origin;
    // React Fast Refresh inserts an inline preamble and Vite injects development styles.
    const policy = [
      "default-src 'none'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
      `connect-src ${origin} ${origin.replace('http:', 'ws:')}`, "img-src 'self'",
      "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
    ].join('; ');
    session.defaultSession.webRequest.onHeadersReceived({ urls: [`${origin}/*`] }, (details, callback) => {
      const responseHeaders = { ...details.responseHeaders };
      if (details.resourceType === 'mainFrame') {
        const key = Object.keys(responseHeaders).find((name) => name.toLowerCase() === 'content-security-policy')
          ?? 'Content-Security-Policy';
        responseHeaders[key] = [...(responseHeaders[key] ?? []), policy];
      }
      callback({ responseHeaders });
    });
  }
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow().catch(fail);
  });
}).catch(fail);

async function fail(error) {
  console.error('Jarvis startup failed.', smoke ? error : { type: error.name });
  quitting = true;
  await stopSidecars();
  if (!smoke) dialog.showErrorBox('Jarvis could not start', 'The renderer could not initialize. See the terminal for details. For npm start, first run npm run build.');
  app.exit(1);
}

app.on('before-quit', (event) => {
  if (cleanupComplete) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  void stopSidecars().then(() => {
    cleanupComplete = true;
    app.quit();
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
