import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children = [];

function run(name, script, delayMs = 0) {
  setTimeout(() => {
    const child = spawn('node', [script], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    const prefix = (line) => `[${name}] ${line}`;
    child.stdout.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l) => console.log(prefix(l))));
    child.stderr.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l) => console.error(prefix(l))));
    child.on('exit', (code) => {
      console.log(`[${name}] exited (${code})`);
      shutdown(code ?? 1);
    });
  }, delayMs);
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('core', 'services/core/src/index.js');
run('sim', 'services/simulator/src/index.js', 1200);
