const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { OllamaSidecar, probeOllama } = require('./sidecars.js');
const { createN8nSidecar } = require('./n8n.cjs');

test('checks version responses and bounds an HTTP request that never finishes', async (t) => {
  const server = http.createServer((request, response) => {
    if (request.url === '/hang') return;
    response.end(request.url === '/api/version' ? '{"version":"0.1.0"}' : '{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await probeOllama(AbortSignal.timeout(1000), `${base}/api/version`), 'ready');
  assert.equal(await probeOllama(AbortSignal.timeout(1000), `${base}/invalid`), 'unhealthy');
  assert.equal(await probeOllama(AbortSignal.timeout(50), `${base}/hang`), 'unhealthy');
});

async function waitFor(condition) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'condition timed out');
    await delay(10);
  }
}

async function serve(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return server;
}

test('n8n rejects an unrelated health responder and reuses an independently ready server', async (t) => {
  let n8n = false;
  let ready = false;
  const requests = [];
  const server = await serve(t, (request, response) => {
    requests.push(request.url);
    if (request.url === '/healthz' || (n8n && request.url === '/healthz/readiness')) {
      response.statusCode = request.url === '/healthz' || ready ? 200 : 503;
      response.end(JSON.stringify({ status: response.statusCode === 200 ? 'ok' : 'error' }));
    } else {
      response.writeHead(404).end();
    }
  });
  let launchCount = 0;
  const options = {
    env: { JARVIS_N8N_PORT: String(server.address().port) },
    platform: 'win32', launch: () => { launchCount++; },
  };
  const collision = createN8nSidecar('unused', options);
  t.after(() => collision.stop());
  collision.start();
  await waitFor(() => collision.status.state === 'failed');
  assert.equal(collision.status.ownership, 'none');
  assert.equal(collision.status.code, 'port-in-use-or-unhealthy');
  assert.equal(requests[0], '/healthz');
  await collision.stop();

  n8n = true;
  const external = createN8nSidecar('unused', { ...options, monitorIntervalMs: 10 });
  t.after(() => external.stop());
  external.start();
  await waitFor(() => external.status.code === 'service-not-ready');
  ready = true;
  await waitFor(() => external.status.ownership === 'external');
  await external.stop();
  assert.equal(launchCount, 0);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/healthz/readiness`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('n8n reports invalid port configuration and a missing launcher', async (t) => {
  const server = await serve(t);
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  for (const [portText, code] of [['65536', 'invalid-port'], [String(port), 'n8n-not-found']]) {
    const service = createN8nSidecar('unused', {
      env: { JARVIS_N8N_PORT: portText },
      platform: 'win32',
    });
    t.after(() => service.stop());
    service.start();
    await waitFor(() => service.status.state === 'failed');
    assert.equal(service.status.code, code);
    await service.stop();
  }
});

test('Windows n8n npm launcher isolates settings and preserves its profile after shutdown', {
  skip: process.platform !== 'win32',
  timeout: 20_000,
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jarvis n8n '));
  const server = await serve(t);
  const port = server.address().port;
  const profile = path.join(root, 'app-data', 'n8n');
  const shim = path.join(root, 'n8n.cmd');
  const sidecar = createN8nSidecar(path.dirname(profile), {
    env: {
      ...process.env, Path: path.dirname(process.execPath), JARVIS_N8N_EXECUTABLE: shim,
      JARVIS_N8N_PORT: String(port), DB_TYPE: 'postgresdb', N8N_ENCRYPTION_KEY: 'external-fixture',
    },
    startupMs: 8000, startupIntervalMs: 50,
  });
  try {
    const cliDir = path.join(root, 'node_modules', 'n8n', 'bin');
    await mkdir(cliDir, { recursive: true });
    await writeFile(shim, '@exit /b 99');
    await writeFile(path.join(cliDir, 'n8n'), `
      const fs = require('node:fs');
      const env = process.env;
      fs.writeFileSync('profile.json', JSON.stringify({
        args: process.argv.slice(2), folder: env.N8N_USER_FOLDER,
        db: env.DB_TYPE, key: env.N8N_ENCRYPTION_KEY, pid: process.pid,
        brokerPort: env.N8N_RUNNERS_BROKER_PORT,
      }));
      require('node:http').createServer((req, res) => res.end('{"status":"ok"}'))
        .listen(Number(env.N8N_PORT), env.N8N_LISTEN_ADDRESS);
    `);
    await new Promise((resolve) => server.close(resolve));
    sidecar.start();
    await waitFor(() => ['ready', 'failed'].includes(sidecar.status.state));
    assert.deepEqual(sidecar.status, { service: 'n8n', state: 'ready', ownership: 'owned', code: null });
    await sidecar.stop();
    const { pid, ...settings } = JSON.parse(await readFile(path.join(profile, 'profile.json'), 'utf8'));
    assert.deepEqual(settings, { args: ['start'], folder: profile, brokerPort: '0' });
    await waitFor(() => {
      try { process.kill(pid, 0); return false; }
      catch (error) { if (error.code === 'ESRCH') return true; throw error; }
    });
  } finally {
    await sidecar.stop();
    await rm(root, { recursive: true });
  }
});

function fixture(t, { result = 'absent', startupMs = 2000 } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin.once('finish', () => child.emit('close', 0, null));
  let launches = 0;
  const sidecar = new OllamaSidecar({
    platform: 'win32',
    startupMs,
    startupIntervalMs: 5,
    monitorIntervalMs: 10,
    probe: async () => result,
    launch: () => { launches++; return child; },
  });
  t.after(() => sidecar.stop());
  return { sidecar, child, setResult: (next) => { result = next; }, launchCount: () => launches };
}

test('reuses and monitors external Ollama without launching or stopping it', async (t) => {
  const { sidecar, launchCount, setResult } = fixture(t, { result: 'ready' });
  sidecar.start();
  await waitFor(() => sidecar.status.ownership === 'external');
  setResult('absent');
  await waitFor(() => sidecar.status.state === 'failed');
  setResult('ready');
  await waitFor(() => sidecar.status.state === 'ready');
  await sidecar.stop();
  assert.equal(sidecar.status.state, 'stopped');
  assert.equal(launchCount(), 0);
});

test('reports an unhealthy occupied endpoint without launching', async (t) => {
  const { sidecar, launchCount } = fixture(t, { result: 'unhealthy' });
  sidecar.start();
  await waitFor(() => sidecar.status.code === 'endpoint-unhealthy');
  assert.equal(launchCount(), 0);
});

test('starts once, reports delayed readiness and handles a launcher exit and external recovery', async (t) => {
  const { sidecar, launchCount, setResult, child } = fixture(t);
  sidecar.start();
  sidecar.start();
  await waitFor(() => sidecar.status.ownership === 'owned');
  assert.equal(sidecar.status.state, 'starting');
  setResult('ready');
  await waitFor(() => sidecar.status.state === 'ready');
  setResult('absent');
  child.emit('close', 73, null);
  assert.equal(sidecar.status.code, 'ollama-exited');
  setResult('ready');
  await waitFor(() => sidecar.status.ownership === 'external');
  assert.equal(launchCount(), 1);
});

test('times out startup and closes the owned launcher', async (t) => {
  const { sidecar, child } = fixture(t, { startupMs: 30 });
  sidecar.start();
  await waitFor(() => sidecar.status.code === 'startup-timeout');
  assert.equal(sidecar.status.ownership, 'none');
  assert.ok(child.stdin.writableEnded);
});

test('reports a missing executable and supports repeated shutdown during startup', async (t) => {
  const missing = fixture(t);
  missing.sidecar.start();
  await waitFor(() => missing.sidecar.status.ownership === 'owned');
  missing.child.emit('close', 71, null);
  assert.equal(missing.sidecar.status.code, 'ollama-not-found');

  const { sidecar, child } = fixture(t);
  sidecar.start();
  await waitFor(() => sidecar.status.ownership === 'owned');
  const stopping = sidecar.stop();
  assert.equal(stopping, sidecar.stop());
  await stopping;
  assert.ok(child.stdin.writableEnded);
  assert.equal(sidecar.status.state, 'stopped');
});

test('Windows launcher closes its job when control ends or the app kills the launcher', {
  skip: process.platform !== 'win32',
  timeout: 20_000,
}, async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'jarvis-ollama-job-'));
  const pids = [];
  function alive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  }

  try {
    // The launcher invokes the configured executable with the fixed "serve" argument.
    await writeFile(path.join(cwd, 'serve'), `
      const { spawn } = require('node:child_process');
      const runner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true });
      console.log(process.pid, runner.pid);
      setInterval(() => {}, 1000);
    `);
    for (const stop of [(child) => child.stdin.end(), (child) => child.kill()]) {
      const launcher = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned',
        '-File', path.join(__dirname, 'sidecar-job.ps1'),
      ], {
        cwd, windowsHide: true, env: { ...process.env, JARVIS_SIDECAR_EXECUTABLE: process.execPath, JARVIS_SIDECAR_ARGS: 'serve' },
      });
      const closed = once(launcher, 'close');
      let output = '';
      let errors = '';
      launcher.stdout.on('data', (chunk) => { output += chunk; });
      launcher.stderr.on('data', (chunk) => { errors += chunk; });
      try {
        await waitFor(() => output.includes('\n') || launcher.exitCode !== null);
        assert.match(output.trim(), /^\d+ \d+$/, errors);
        const ownedPids = output.trim().split(' ').map(Number);
        pids.push(...ownedPids);
        assert.ok(ownedPids.every(alive));
        stop(launcher);
        await closed;
        await waitFor(() => ownedPids.every((pid) => !alive(pid)));
        pids.length = 0;
      } finally {
        launcher.kill();
        await closed;
      }
    }
  } finally {
    for (const pid of pids.filter(alive)) process.kill(pid);
    await rm(cwd, { recursive: true });
  }
});
