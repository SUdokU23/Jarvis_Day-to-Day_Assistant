import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electron from 'electron';

const server = await createServer();
let child;
let stopping = false;

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32') {
      await new Promise((resolve) => {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
        killer.once('error', (error) => { console.error(error); resolve(); });
        killer.once('exit', resolve);
      });
    } else {
      child.kill('SIGTERM');
    }
  }
  await server.close();
  process.exitCode = code;
}

process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });

try {
  await server.listen();
  server.printUrls();
  if (!stopping) {
    child = spawn(electron, ['.', ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: { ...process.env, JARVIS_DEV_URL: server.resolvedUrls.local[0] },
      windowsHide: true,
    });
    child.once('error', (error) => { console.error(error); void stop(1); });
    child.once('exit', (code, signal) => { void stop(code ?? (signal ? 1 : 0)); });
  }
} catch (error) {
  console.error(error);
  await stop(1);
}
