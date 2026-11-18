import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const state = resolve(process.env.WDK_E2E_STATE ?? join(here, '../../../.cache/arkade-wdk-e2e'));
const regtest = join(state, 'regtest');
const pin = 'f7c09c136fe316142ba2e9686921f40eae9d7a84';
const composeFiles = ['compose.base.yml', 'compose.ark.yml', 'compose.evm.yml'];
const [action, ...args] = process.argv.slice(2);
const run = (command, argv, capture = false) => execFileSync(command, argv, {
  encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', env: process.env,
});
if (!action || action === '--help') {
  console.log('node test/e2e/stack/stack.mjs prepare | check | compose <args...> | cards | fund');
  process.exit(0);
}
if (action === 'prepare') {
  mkdirSync(state, { recursive: true });
  if (!existsSync(join(regtest, '.git'))) {
    run('git', ['init', regtest]);
    run('git', ['-C', regtest, 'remote', 'add', 'origin', 'https://github.com/ArkLabsHQ/arkade-regtest.git']);
    run('git', ['-C', regtest, 'fetch', '--depth', '1', 'origin', pin]);
    run('git', ['-C', regtest, 'checkout', '--detach', 'FETCH_HEAD']);
  }
  if (run('git', ['-C', regtest, 'rev-parse', 'HEAD'], true).trim() !== pin) throw new Error('Unexpected regtest checkout; use a fresh WDK_E2E_STATE');
  for (const file of ['stack.env', 'solver.json', 'nginx.conf']) copyFileSync(join(here, file), join(state, file));
  mkdirSync(join(state, 'tls'), { recursive: true });
  if (!existsSync(join(state, 'tls/cert.pem'))) {
    run(process.env.OPENSSL_BIN ?? 'openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30',
      '-keyout', join(state, 'tls/key.pem'), '-out', join(state, 'tls/cert.pem'), '-subj', '/CN=wdk-e2e-local',
      '-addext', 'subjectAltName=DNS:localhost,DNS:nostr-tls,IP:127.0.0.1']);
  }
  const base = join(regtest, 'docker/compose.base.yml');
  const source = readFileSync(base, 'utf8');
  if (!source.includes('10.222.57.0/24')) writeFileSync(base, source.replace(/^volumes:/m,
    'networks:\n  default:\n    ipam:\n      config:\n        - subnet: 10.222.57.0/24\n\nvolumes:'));
  for (const file of composeFiles) {
    const path = join(regtest, 'docker', file);
    const source = readFileSync(path, 'utf8');
    writeFileSync(path, source.replace(/(^ +ports:\r?\n)((?: +- [^\r\n]+\r?\n)+)/gm,
      (_, header, bindings) => header + bindings.replace(/^( +- )(.+?)[ \t]*$/gm,
        (_, indent, binding) => {
          const port = binding.replace(/^(['"])(.*)\1$/, '$2');
          return `${indent}'${port.startsWith('127.0.0.1:') ? port : `127.0.0.1:${port}`}'`;
        })));
  }
  console.log(`Prepared ${state}; test keys and certificates are regtest-only.`);
  process.exit(0);
}
if (!existsSync(join(regtest, '.env.defaults'))) throw new Error('Run prepare first');
const { loadEnv } = await import(pathToFileURL(join(regtest, 'lib/env.mjs')).href);
loadEnv(regtest, join(state, 'stack.env'));
process.env.WDK_E2E_STATE = state.replaceAll('\\', '/');
const prefix = process.env.REGTEST_CONTAINER_PREFIX;
const solver = `${prefix}intent-solver`;
const cli = ['node', '--enable-source-maps', '--experimental-eventsource', 'packages/solver-app/dist/cli.js'];
const files = composeFiles.flatMap((file) => ['-f', join(regtest, 'docker', file)]);
const compose = ['compose', '-p', process.env.REGTEST_PROJECT, ...files, '-f', join(here, 'compose.yml')];
if (action === 'check') {
  const config = JSON.parse(run('docker', [...compose, '--profile', '*', 'config', '--format', 'json'], true));
  const ports = Object.entries(config.services).flatMap(([name, service]) =>
    (service.ports ?? []).map((port) => ({ service: name, ...port })));
  const unsafe = ports.filter((port) => port.host_ip !== '127.0.0.1');
  if (!ports.length || unsafe.length) {
    throw new Error(`Expected only loopback port bindings: ${JSON.stringify(unsafe)}`);
  }
  console.log(`Verified ${ports.length} published ports bind only to 127.0.0.1.`);
} else if (action === 'compose') {
  run('docker', [...compose, ...args]);
} else if (action === 'cards') {
  const output = run('docker', ['exec', solver, ...cli, 'card', 'wdk-e2e'], true);
  const card = JSON.parse(output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1));
  writeFileSync(join(state, 'solver-card.json'), `${JSON.stringify(card, null, 2)}\n`);
  writeFileSync(join(regtest, 'docker/.lnurl-solver-cards.json'), `${JSON.stringify([card])}\n`);
  writeFileSync(join(state, 'tls/registry.json'), `${JSON.stringify({ version: 0, network: 'regtest',
    generated_at: Math.floor(Date.now() / 1000), commit: pin, markets: [],
    solvers: [{ name: card.name, discovery_pubkey: card.discovery_pubkey, transports: card.transports }],
  })}\n`);
  run('docker', ['exec', `${prefix}nostr-tls`, 'nginx', '-s', 'reload']);
} else if (action === 'fund') {
  const output = run('docker', ['exec', solver, ...cli, 'balances'], true);
  const address = /arkade address:\s*(\S+)/.exec(output)?.[1];
  const balance = /arkade balance:\s*(\{[^\n]+\})/.exec(output)?.[1];
  if (!address || !balance) throw new Error('Cannot read solver address/balance');
  if (JSON.parse(balance).available < 5000000) run('docker', ['exec', `${prefix}arkd`, 'ark', 'send', '--to', address, '--amount', '5000000', '--password', 'secret']);
} else throw new Error(`Unknown action: ${action}`);
