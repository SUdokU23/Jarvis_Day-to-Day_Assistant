const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { OllamaSidecar, probeOllama } = require('./sidecars.js');

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
        '-File', path.join(__dirname, 'ollama-job.ps1'),
      ], {
        cwd, windowsHide: true, env: { ...process.env, JARVIS_OLLAMA_EXECUTABLE: process.execPath },
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
