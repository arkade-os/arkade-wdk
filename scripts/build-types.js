import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
rmSync(new URL('../types/', import.meta.url), { recursive: true, force: true });
execFileSync(
  process.execPath,
  [
    fileURLToPath(new URL('./bin/tsc', import.meta.resolve('typescript/package.json'))),
    '-p',
    'tsconfig.json',
  ],
  {
    cwd: project,
    stdio: 'inherit',
  }
);
