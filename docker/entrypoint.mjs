#!/usr/bin/env node
import { spawn } from 'node:child_process';
import process from 'node:process';

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
    console.error(`[entrypoint] process '${name}' exited unexpectedly (${reason}). Triggering container shutdown so Docker can restart.`);
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
  let watchdog = setInterval(() => {
    let allDead = true;
    for (const p of procs) {
      if (p.child.exitCode === null && p.child.signalCode === null) {
        allDead = false;
        break;
      }
    }
    if (allDead) {
      clearInterval(watchdog);
      clearTimeout(forceAfter);
      process.exit(0);
    }
  }, 500);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

console.log('[entrypoint] starting api...');
start(
  'api',
  'node',
  ['apps/api/src/index.js'],
  '/app',
  {
    NODE_ENV: process.env.NODE_ENV || 'production',
    PORT: process.env.PORT || '8787',
    STORAGE_ROOT: process.env.STORAGE_ROOT || '/app/storage',
    CORS_ORIGIN: process.env.CORS_ORIGIN || '',
    DOC_ENGINE_URL: process.env.DOC_ENGINE_URL || 'http://127.0.0.1:8788',
  }
);

console.log('[entrypoint] starting web...');
start(
  'web',
  'node',
  ['apps/web/standalone/apps/web/server.js'],
  '/app',
  {
    NODE_ENV: process.env.NODE_ENV || 'production',
    PORT: process.env.WEB_PORT || '3000',
    HOSTNAME: '0.0.0.0',
    NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8787',
  }
);

console.log('[entrypoint] starting doc-engine...');
start(
  'doc-engine',
  'python3',
  ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '8788', '--no-access-log'],
  '/app/apps/api/docengine',
  {
    PYTHONPATH: '/app/apps/api/docengine:/opt/docsite',
    PYTHONUNBUFFERED: '1',
  }
);
