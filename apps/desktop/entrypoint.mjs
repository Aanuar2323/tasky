#!/usr/bin/env node
import { spawn } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APPDATA_DIR = process.env.APPDATA || process.env.LOCALAPPDATA || path.join(process.env.HOME || '/tmp', '.tasky');
const STORAGE_ROOT = process.env.STORAGE_ROOT || path.join(APPDATA_DIR, 'storage');
const PORT = process.env.PORT || '8787';
const WEB_PORT = process.env.WEB_PORT || '3000';

const apiSrcDir = path.resolve(__dirname, 'apps', 'api', 'src');
const webStandaloneDir = path.resolve(__dirname, 'apps', 'web', 'standalone', 'apps', 'web');

const procs = [];
let shuttingDown = false;

function start(name, command, args, cwd, envExtra) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...envExtra },
    stdio: 'inherit',
    detached: false,
  });
  procs.push({ name, child });

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    console.error(`[entrypoint] process '${name}' exited unexpectedly (${reason}). Triggering shutdown.`);
    shuttingDown = true;
    for (const p of procs) {
      if (p.child !== child && !p.child.killed) {
        try { p.child.kill('SIGTERM'); } catch {}
      }
    }
    process.exit(code ?? 1);
  });

  return child;
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[entrypoint] received ${signal}, stopping processes...`);
  for (const p of procs) {
    if (!p.child.killed) {
      try { p.child.kill('SIGTERM'); } catch {}
    }
  }
  const forceAfter = setTimeout(() => {
    for (const p of procs) {
      try { p.child.kill('SIGKILL'); } catch {}
    }
  }, 8000);
  let exited = 0;
  for (const p of procs) {
    p.child.on('exit', () => {
      exited += 1;
      if (exited === procs.length) {
        clearTimeout(forceAfter);
        process.exit(0);
      }
    });
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

console.log('[entrypoint] starting api...');
start(
  'api',
  'node',
  [path.join(apiSrcDir, 'index.js')],
  __dirname,
  {
    NODE_ENV: process.env.NODE_ENV || 'production',
    PORT,
    STORAGE_ROOT,
    CORS_ORIGIN: process.env.CORS_ORIGIN || `http://localhost:${WEB_PORT}`,
  }
);

console.log('[entrypoint] starting web...');
start(
  'web',
  'node',
  [path.join(webStandaloneDir, 'server.js')],
  __dirname,
  {
    NODE_ENV: process.env.NODE_ENV || 'production',
    PORT: WEB_PORT,
    HOSTNAME: '127.0.0.1',
    NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL || `http://localhost:${PORT}`,
  }
);