const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { existsSync } = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const endpoint = 'http://127.0.0.1:11434/api/version';
const inventoryEndpoint = new URL('/api/tags', endpoint);

function probeJson(signal, url, classify, acceptedStatuses = [200], maxLength = 4096) {
  return new Promise((resolve) => {
    const request = http.get(url, { agent: false, signal }, (response) => {
      if (!acceptedStatuses.includes(response.statusCode)) {
        resolve('unhealthy');
        request.destroy();
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > maxLength) {
          resolve('unhealthy');
          request.destroy();
        }
      });
      response.on('error', () => resolve('unhealthy'));
      response.on('end', () => {
        try {
          resolve(classify(JSON.parse(body), response.statusCode));
        } catch {
          resolve('unhealthy');
        }
      });
    });
    request.on('error', (error) => resolve(error.code === 'ECONNREFUSED' ? 'absent' : 'unhealthy'));
  });
}

function probeOllama(signal, url = endpoint) {
  return probeJson(signal, url, ({ version }) =>
    typeof version === 'string' && version.trim() ? 'ready' : 'unhealthy', [200], 4096);
}

function canonicalModel(name) {
  const identifier = name.toLowerCase();
  return identifier.split('/').at(-1).includes(':') ? identifier : `${identifier}:latest`;
}

async function probeModel(signal, model, url = inventoryEndpoint) {
  const configured = canonicalModel(model);
  const result = await probeJson(signal, url, ({ models }) => {
    if (!Array.isArray(models) || !models.every((entry) => typeof entry?.name === 'string' && entry.name.trim())) {
      return 'unhealthy';
    }
    return models.some(({ name }) => canonicalModel(name) === configured) ? 'ready' : 'missing';
  }, [200], 1024 * 1024);
  return result === 'ready' || result === 'missing' ? result : 'check-failed';
}

function launchOllama() {
  const installed = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe');
  const executable = process.env.JARVIS_OLLAMA_EXECUTABLE || (installed && existsSync(installed) ? installed : 'ollama.exe');
  return launchWindowsJob(executable, 'serve', { ...process.env, OLLAMA_HOST: '127.0.0.1:11434' });
}

function launchWindowsJob(executable, args, env, cwd) {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return spawn(powershell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned',
    '-File', path.join(__dirname, 'sidecar-job.ps1'),
  ], {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd,
    env: { ...env, JARVIS_SIDECAR_EXECUTABLE: executable, JARVIS_SIDECAR_ARGS: args },
  });
}

class SidecarSupervisor extends EventEmitter {
  #controller = new AbortController();
  #status;
  #model;
  #run;
  #shutdown;
  #owned;

  constructor({ service, probe, launch, occupiedCode = 'endpoint-unhealthy', startupMs = 60_000,
    checkModel, model,
    startupIntervalMs = 500, monitorIntervalMs = 5000, platform = process.platform } = {}) {
    super();
    this.#status = Object.freeze({ service, state: 'stopped', ownership: 'none', code: null, ...(checkModel && { model: null }) });
    this.occupiedCode = occupiedCode;
    this.probe = probe;
    this.checkModel = checkModel;
    this.#model = model?.trim() || 'llama3.2';
    this.launch = launch;
    this.startupMs = startupMs;
    this.startupIntervalMs = startupIntervalMs;
    this.monitorIntervalMs = monitorIntervalMs;
    this.platform = platform;
  }

  get status() { return this.#status; }

  #publish(state, ownership = 'none', code = null, modelState = null) {
    if (this.#status.state === state && this.#status.ownership === ownership && this.#status.code === code
        && this.#status.model?.state === (state === 'ready' && this.checkModel ? modelState : undefined)) return;
    const model = state === 'ready' ? Object.freeze({ name: this.#model, state: modelState }) : null;
    this.#status = Object.freeze({ service: this.#status.service, state, ownership, code, ...(this.checkModel && { model }) });
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
    if (initial === 'invalid-port') {
      this.#publish('failed', 'none', initial);
      return;
    }
    if (initial === 'ready') {
      this.#publish('ready', 'external');
    } else if (initial !== 'absent') {
      this.#publish('failed', 'none', initial === 'not-ready' ? 'service-not-ready' : this.occupiedCode);
    } else if (this.platform !== 'win32') {
      this.#publish('failed', 'none', 'managed-start-requires-windows');
    } else {
      await this.#startOwned();
    }

    while (!signal.aborted) {
      if (this.checkModel && this.#status.state === 'ready') {
        const status = this.#status;
        const modelState = await this.checkModel(AbortSignal.any([signal, AbortSignal.timeout(2000)]), this.#model);
        if (signal.aborted) return;
        if (this.#status === status) this.#publish(status.state, status.ownership, null, modelState);
      }
      await delay(this.monitorIntervalMs, undefined, { signal });
      const result = await this.#check();
      if (signal.aborted) return;
      if (result === 'ready') this.#publish('ready', this.#owned ? 'owned' : 'external', null,
        this.#status.model?.state ?? null);
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
    let child;
    try {
      child = this.launch();
    } catch (error) {
      const code = error.code === 'ENOENT' ? `${this.#status.service}-not-found` : 'launcher-setup-failed';
      this.#publish('failed', 'none', code);
      return;
    }
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
            70: 'job-setup-failed',
            71: `${this.#status.service}-not-found`,
            72: `${this.#status.service}-spawn-failed`,
            73: `${this.#status.service}-exited`,
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

class OllamaSidecar extends SidecarSupervisor {
  constructor(options) {
    super({ service: 'ollama', probe: probeOllama, launch: launchOllama, checkModel: probeModel,
      model: process.env.JARVIS_OLLAMA_MODEL, ...options });
  }
}

module.exports = { OllamaSidecar, probeOllama, probeModel, SidecarSupervisor, probeJson, launchWindowsJob };
