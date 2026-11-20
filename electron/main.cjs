const { app, BrowserWindow, dialog, session } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { OllamaSidecar } = require('./sidecars.js');

const { createN8nSidecar } = require('./n8n.cjs');
const { createPromptHandler } = require('./prompt-bridge.cjs');

const smoke = process.argv.includes('--smoke-test');
const sidecars = [new OllamaSidecar(), createN8nSidecar(app.getPath('userData'))];
let quitting = false;
let cleanupComplete = false;

for (const sidecar of sidecars) {
  const label = `[${sidecar.status.service}]`;
  sidecar.on('status', (status) => console.info(label, status));
  sidecar.on('diagnostic', (diagnostic) => console.info(label, diagnostic));
}

function stopSidecars() {
  return Promise.all(sidecars.map((sidecar) => sidecar.stop()));
}
const devUrl = !app.isPackaged && process.env.JARVIS_DEV_URL;
const builtUrl = pathToFileURL(path.join(__dirname, '../dist/index.html')).href;

if (devUrl) {
  const url = new URL(devUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) {
    throw new Error('Development renderer must use the loopback Vite server.');
  }
}

async function createWindow() {
  const window = new BrowserWindow({
    width: 1100, height: 760, minWidth: 480, minHeight: 400,
    backgroundColor: '#020617', show: !smoke,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  const rendererUrl = new URL(devUrl || builtUrl).href;
  window.webContents.ipc.handle('send-prompt', createPromptHandler(rendererUrl));
  await window.loadURL(rendererUrl);
  if (smoke) {
    const result = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      function check() {
        const main = document.querySelector('main');
        if (main && window.jarvis) {
          resolve({ heading: document.querySelector('h1')?.textContent,
            node: typeof require, process: typeof process,
            platform: window.jarvis.platform, background: getComputedStyle(main).backgroundColor });
        } else if (Date.now() > deadline) reject(new Error('Renderer or preload did not initialize'));
        else setTimeout(check, 50);
      }
      check();
    })`);
    const invalidPrompt = await window.webContents.executeJavaScript("window.jarvis.sendPrompt('  ')");
    const preferences = window.webContents.getLastWebPreferences();
    if (result.heading !== 'Jarvis' || result.node !== 'undefined' || result.process !== 'undefined'
        || result.background === 'rgba(0, 0, 0, 0)' || !preferences.contextIsolation
        || preferences.nodeIntegration || !preferences.sandbox
        || invalidPrompt.success !== false || invalidPrompt.error?.code !== 'INVALID_PROMPT') {
      throw new Error(`Smoke check failed: ${JSON.stringify(result)}`);
    }
    console.log('SMOKE PASS', JSON.stringify(result));
    app.quit();
  }
}

app.whenReady().then(async () => {
  if (quitting) return;
  for (const sidecar of sidecars) sidecar.start();
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const connect = devUrl ? ` ${new URL(devUrl).origin} ${new URL(devUrl).origin.replace('http:', 'ws:')}` : '';
    // React Fast Refresh inserts an inline preamble; Vite also injects development styles.
    const inline = devUrl ? " 'unsafe-inline'" : '';
    const policy = `default-src 'self'; script-src 'self'${inline}; style-src 'self'${inline}; img-src 'self' data:; connect-src 'self'${connect}; object-src 'none'; base-uri 'none'; frame-src 'none'`;
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [policy] } });
  });
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow().catch(fail);
  });
}).catch(fail);

async function fail(error) {
  console.error(error);
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
