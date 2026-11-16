#!/usr/bin/env node
/**
 * Start the whole stack with one command: relay + reference agent + dashboard.
 *
 *   npm run dev            # LAN demo on :5173, agent :8787, relay :8788
 *   npm run dev -- --tunnel # optional: expose the relay through a public URL
 *
 * Every child gets a coloured prefix so three log streams stay readable.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const COLORS = { relay: '\x1b[38;5;45m', agent: '\x1b[38;5;141m', web: '\x1b[38;5;220m' };
const RESET = '\x1b[0m';

const children = [];
function start(label, command, args, cwd = root) {
  const child = spawn(command, args, {
    cwd,
    shell: process.platform === 'win32',
    env: { ...process.env, FORCE_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tag = `${COLORS[label] || ''}${label.padEnd(5)}${RESET}`;
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', (line) => {
      if (line.trim()) console.log(`${tag} ${line}`);
    });
  }
  child.on('exit', (code, signal) => {
    if (!shuttingDown) console.log(`${tag} exited (${signal || code})`);
  });
  children.push(child);
  return child;
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    if (!c.killed) { try { c.kill('SIGTERM'); } catch { /* ignore */ } }
  }
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('\n  Airlock dev stack');
console.log('  dashboard  http://localhost:5173');
console.log('  demo link  http://localhost:5173/?demo=1');
console.log('  agent      ws://localhost:8787/agent  (code 123456)');
console.log('  relay      http://localhost:8788/health\n');

start('relay', process.execPath, ['apps/relay/server.mjs']);
start('agent', process.execPath, ['apps/agent/agent.mjs', '--name', 'Pixel 8 (dev)']);
start('web', npm, ['--workspace', 'apps/web', 'run', 'dev', '--', '--host', '127.0.0.1']);
