const { mkdirSync, statSync } = require('node:fs');
const path = require('node:path');
const { SidecarSupervisor, launchWindowsJob, probeJson } = require('./sidecars.js');

async function probeN8n(signal, port) {
  const health = `http://127.0.0.1:${port}/healthz`;
  const result = await probeJson(signal, health, (body) => body?.status === 'ok' ? 'ready' : 'unhealthy');
  if (result !== 'ready') return result;
  const readiness = await probeJson(signal, `${health}/readiness`, (body, status) => {
    if (status === 200 && body?.status === 'ok') return 'ready';
    if (status === 503 && body?.status === 'error') return 'not-ready';
    return 'unhealthy';
  }, [200, 503]);
  return readiness === 'absent' ? 'unhealthy' : readiness;
}

function isFile(file) {
  return statSync(file, { throwIfNoEntry: false })?.isFile();
}

function findOnPath(name, env) {
  return (env.Path ?? env.PATH ?? '').split(path.delimiter)
    .map((directory) => directory.replace(/^"|"$/g, ''))
    .filter((directory) => path.isAbsolute(directory))
    .map((directory) => path.join(directory, name))
    .find(isFile);
}

function launchN8n(userFolder, port, env) {
  const configured = env.JARVIS_N8N_EXECUTABLE;
  if (configured && (!path.isAbsolute(configured) || !/\.(cmd|exe)$/i.test(configured))) {
    throw new Error('Expected an absolute path to n8n.cmd or an executable');
  }
  let executable = configured || findOnPath('n8n.cmd', env) || findOnPath('n8n.exe', env);
  let args = 'start';
  if (executable && /\.cmd$/i.test(executable)) {
    // Resolve the standard Windows npm shim layout without evaluating the batch file.
    const directory = path.dirname(executable);
    const modules = path.basename(directory).toLowerCase() === '.bin'
      ? path.dirname(directory)
      : path.join(directory, 'node_modules');
    const cli = path.join(modules, 'n8n', 'bin', 'n8n');
    const node = path.join(directory, 'node.exe');
    executable = isFile(executable) && isFile(cli)
      ? (isFile(node) ? node : findOnPath('node.exe', env))
      : undefined;
    args = `"${cli}" start`;
  }
  if (!executable || !isFile(executable)) {
    throw Object.assign(new Error('n8n launcher missing'), { code: 'ENOENT' });
  }

  mkdirSync(userFolder, { recursive: true });
  // Let n8n generate its encryption key in this profile. Inheriting an external
  // instance's environment could connect to its database or reuse its secrets.
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) =>
    /^(path|systemroot|windir|temp|tmp|appdata|localappdata|userprofile|homedrive|homepath|comspec|programdata|os|pathext)$/i.test(key)));
  return launchWindowsJob(executable, args, {
    ...childEnv,
    N8N_USER_FOLDER: userFolder,
    N8N_HOST: '127.0.0.1',
    N8N_LISTEN_ADDRESS: '127.0.0.1',
    N8N_PORT: String(port),
    N8N_PROTOCOL: 'http',
    // n8n passes the resolved ephemeral broker port to its internal task runners.
    N8N_RUNNERS_BROKER_PORT: '0',
  }, userFolder);
}

function readN8nPort(env) {
  const portText = env.JARVIS_N8N_PORT ?? '5678';
  const port = Number(portText);
  return /^\d+$/.test(portText) && port >= 1 && port <= 65535 ? port : null;
}

function createN8nSidecar(appData, { env = process.env, ...supervisorOptions } = {}) {
  const port = readN8nPort(env);
  return new SidecarSupervisor({
    service: 'n8n',
    probe: (signal) => port !== null ? probeN8n(signal, port) : 'invalid-port',
    launch: () => launchN8n(path.join(appData, 'n8n'), port, env),
    occupiedCode: 'port-in-use-or-unhealthy',
    ...supervisorOptions,
  });
}

module.exports = { createN8nSidecar, readN8nPort };
