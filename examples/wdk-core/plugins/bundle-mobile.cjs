const { spawnSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const target = process.argv[2] ?? 'android';
const bin = require.resolve('@tetherto/wdk-worklet-bundler/bin/wdk-worklet-bundler.js');
const cwd = resolve(__dirname, '..');

function generate(...options) {
  const result = spawnSync(process.execPath, [bin, 'generate', ...options], {
    cwd,
    env: { ...process.env, WDK_WORKLET_TARGET: target },
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

generate('--source-only');
const entry = join(cwd, '.wdk', 'wdk-worklet.generated.js');
const source = readFileSync(entry, 'utf8');
const ipcSlot = 'const { IPC: BareIPC } = BareKit';
if (source.split(ipcSlot).length !== 2) throw new Error('Unexpected WDK HRPC worklet entry');
// The bundler still emits BareKit.IPC; React Native Bare Kit 0.17 exposes Bare.IPC.
writeFileSync(
  entry,
  source.replace(ipcSlot, 'const { IPC: BareIPC } = globalThis.BareKit ?? Bare')
);
generate('--skip-generation');
