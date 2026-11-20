const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { existsSync } = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const endpoint = 'http://127.0.0.1:11434/api/version';

function probeOllama(signal, url = endpoint) {
  return new Promise((resolve) => {
    const request = http.get(url, { agent: false, signal }, (response) => {
      if (response.statusCode !== 200) {
        resolve('unhealthy');
        request.destroy();
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 4096) {
          resolve('unhealthy');
          request.destroy();
        }
      });
      response.on('error', () => resolve('unhealthy'));
      response.on('end', () => {
        try {
          const { version } = JSON.parse(body);
          resolve(typeof version === 'string' && version.trim() ? 'ready' : 'unhealthy');
        } catch {
          resolve('unhealthy');
        }
      });
    });
    request.on('error', (error) => resolve(error.code === 'ECONNREFUSED' ? 'absent' : 'unhealthy'));
  });
}

function launchOllama() {
  const installed = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe');
  const executable = process.env.JARVIS_OLLAMA_EXECUTABLE || (installed && existsSync(installed) ? installed : 'ollama.exe');
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return spawn(powershell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned',
    '-File', path.join(__dirname, 'ollama-job.ps1'),
  ], {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, JARVIS_OLLAMA_EXECUTABLE: executable, OLLAMA_HOST: '127.0.0.1:11434' },
  });
}

class OllamaSidecar extends EventEmitter {
  #controller = new AbortController();
  #status = Object.freeze({ service: 'ollama', state: 'stopped', ownership: 'none', code: null });
  #run;
  #shutdown;
  #owned;

  constructor({ probe = probeOllama, launch = launchOllama, startupMs = 60_000,
    startupIntervalMs = 500, monitorIntervalMs = 5000, platform = process.platform } = {}) {
    super();
    this.probe = probe;
    this.launch = launch;
    this.startupMs = startupMs;
    this.startupIntervalMs = startupIntervalMs;
    this.monitorIntervalMs = monitorIntervalMs;
    this.platform = platform;
  }

  get status() { return this.#status; }

  #publish(state, ownership = 'none', code = null) {
    if (this.#status.state === state && this.#status.ownership === ownership && this.#status.code === code) return;
    this.#status = Object.freeze({ service: 'ollama', state, ownership, code });
    this.emit('status', this.#status);
  }

  start() {
    if (this.#run || this.#shutdown) return;
    this.#run = Promise.resolve().then(() => this.#supervise()).catch((error) => {
      if (this.#controller.signal.aborted) return;
      this.#publish('failed', this.#owned ? 'owned' : 'none', 'supervisor-failed');
      this.emit('diagnostic', { code: 'supervisor-failed', type: error.name });
    });
  }

  async #supervise() {
    const signal = this.#controller.signal;
    if (signal.aborted) return;
    this.#publish('starting');
    const initial = await this.#check();
    if (signal.aborted) return;
    if (initial === 'ready') {
      this.#publish('ready', 'external');
    } else if (initial !== 'absent') {
      this.#publish('failed', 'none', 'endpoint-unhealthy');
    } else if (this.platform !== 'win32') {
      this.#publish('failed', 'none', 'managed-start-requires-windows');
    } else {
      await this.#startOwned();
    }

    while (!signal.aborted) {
      await delay(this.monitorIntervalMs, undefined, { signal });
      const result = await this.#check();
      if (signal.aborted) return;
      if (result === 'ready') this.#publish('ready', this.#owned ? 'owned' : 'external');
      else if (this.#status.state === 'ready') {
        this.#publish('failed', this.#owned ? 'owned' : 'none', 'health-check-failed');
      }
    }
  }

  #check(timeoutMs = 2000, signal = this.#controller.signal) {
    return this.probe(AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]));
  }

  async #startOwned() {
    const signal = this.#controller.signal;
    const deadline = performance.now() + this.startupMs;
    const child = this.launch();
    const ended = new AbortController();
    const startupSignal = AbortSignal.any([signal, ended.signal]);
    const owned = { child };
    this.#owned = owned;
    child.stdin.on('error', () => {});
    const outputBytes = { stdout: 0, stderr: 0 };
    for (const stream of ['stdout', 'stderr']) {
      child[stream].on('data', (chunk) => { outputBytes[stream] += chunk.length; });
    }
    let spawnError;
    child.once('error', (error) => { spawnError = error.code; });
    owned.closed = new Promise((resolve) => {
      child.once('close', (exitCode, exitSignal) => {
        this.#owned = undefined;
        ended.abort();
        this.emit('diagnostic', { exitCode, exitSignal, spawnError, outputBytes });
        if (!signal.aborted && !owned.stopping) {
          const code = spawnError ? 'launcher-spawn-failed' : ({
            70: 'job-setup-failed', 71: 'ollama-not-found', 72: 'ollama-spawn-failed', 73: 'ollama-exited',
          }[exitCode] || 'launcher-exited');
          this.#publish('failed', 'none', code);
        }
        resolve();
      });
    });
    this.#publish('starting', 'owned');
    while (!startupSignal.aborted && performance.now() < deadline) {
      const remaining = Math.max(1, Math.floor(deadline - performance.now()));
      const result = await this.#check(Math.min(2000, remaining), startupSignal);
      if (startupSignal.aborted) return;
      if (result === 'ready') {
        this.#publish('ready', 'owned');
        return;
      }
      await delay(Math.min(this.startupIntervalMs, Math.max(0, deadline - performance.now())), undefined,
        { signal: startupSignal }).catch((error) => {
        if (error.name !== 'AbortError') throw error;
      });
    }
    if (startupSignal.aborted) return;
    await this.#stopOwned(owned);
    if (!signal.aborted) this.#publish('failed', 'none', 'startup-timeout');
  }

  async #stopOwned(owned) {
    if (owned.stopping) return owned.closed;
    owned.stopping = true;
    owned.child.stdin.end();
    const force = setTimeout(() => owned.child.kill(), 1000);
    try {
      await owned.closed;
    } finally {
      clearTimeout(force);
    }
  }

  stop() {
    this.#shutdown ??= Promise.resolve().then(async () => {
      this.#controller.abort();
      if (this.#owned) await this.#stopOwned(this.#owned);
      await this.#run;
      this.#publish('stopped');
    });
    return this.#shutdown;
  }
}

module.exports = { OllamaSidecar, probeOllama };
