import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);

// Executes WDKService source and generated HRPC with funded regtest payments.
// Node HTTP, crypto, SQLite and keychain adapters replace device APIs; no native app is run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomBytes, createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { Duplex } = require('node:stream');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const rootRequire = createRequire(path.join(root, 'package.json'));
const provider = process.env.ARKADE_E2E_PROVIDER_DIR ?? path.join(root, 'packages/wdk-react-native-provider');
const pear = process.env.ARKADE_E2E_PEAR_DIR ?? path.join(root, 'packages/pear-wrk-wdk');
const sample = process.env.ARKADE_E2E_SAMPLE_DIR ?? path.join(root, 'examples/wdk-starter-react-native');
const sampleRequire = createRequire(path.join(sample, 'package.json'));
const ts = sampleRequire('typescript');
const sdk = rootRequire('@arkade-os/sdk');
const { closeSharedNostrPool } = rootRequire('@arkade-os/swap/nostr');
const operator = process.env.ARKADE_E2E_SERVER_URL ?? 'http://127.0.0.1:57020';
const esploraUrl = process.env.ARKADE_E2E_ESPLORA_URL ?? 'http://127.0.0.1:57000/api';
const emulatorUrl = process.env.ARKADE_E2E_EMULATOR_URL ?? 'http://127.0.0.1:57023';
const registryUrl = process.env.ARKADE_E2E_REGISTRY_URL ?? 'https://localhost:57033/registry.json';
const lnurlUrl = process.env.ARKADE_E2E_LNURL_URL ?? 'http://localhost:57032';
const domain = process.env.ARKADE_E2E_LNURL_DOMAIN ?? 'localhost';
const prefix = process.env.ARKADE_E2E_CONTAINER_PREFIX ?? 'wdk-e2e-';
const selected = new Set(['setConfig', 'getChainsConfig', 'onArkadeBalanceChange',
  'notifyArkadeBalanceListeners', 'initArkadeWallet', 'createWallet', 'quoteSendByNetwork',
  'sendByNetwork', 'getDenominationValue', 'getLnurlReceiver', 'getBoardingAddress',
  'requireArkadeSwapClient', 'getSwapMarkets', 'createLightningInvoice', 'clearWallet']);
const file = path.join(provider, 'src/services/wdk-service/index.ts');
const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
const declaration = source.statements.find(ts.isClassDeclaration);
const methods = declaration.members.filter(m => selected.has(m.name?.getText(source))).map(m => m.getText(source));
assert.equal(methods.length, selected.size);
const serviceCode = ts.transpileModule(`class Service { ${methods.join('\n')} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const typeCode = ts.transpileModule(fs.readFileSync(path.join(provider, 'src/services/wdk-service/types.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const types = {};
new Function('exports', typeCode)(types);
const HRPC = require(path.join(pear, 'spec/hrpc'));
const workletFile = path.join(pear, 'src/wdk-worklet.js');
const workletRequire = createRequire(workletFile);
const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'arkade-wdk-sample-'));
const allDatabases = [];
const services = [];

function makeService(seed, databaseId = services.length) {
  let resetCalls = 0;
  const databases = new Map();
  const clientStream = new Duplex({ read() {}, write(chunk, _encoding, done) { serverStream.push(chunk); done(); } });
  const serverStream = new Duplex({ read() {}, write(chunk, _encoding, done) { clientStream.push(chunk); done(); } });
  vm.runInNewContext(fs.readFileSync(workletFile, 'utf8'), { BareKit: { IPC: serverStream }, require: workletRequire }, { filename: workletFile });
  const rpc = new HRPC(clientStream);
  const shimRequire = name => {
    if (name === '@arkade-os/sdk/adapters/expo') return { ExpoOperatorProvider: sdk.RestOperatorProvider, ExpoIndexerProvider: sdk.RestIndexerProvider };
    if (name === 'expo/fetch') return { fetch };
    if (name === 'expo-crypto') return { digestStringAsync: async (_algorithm, text) => createHash('sha256').update(text).digest('hex') };
    if (name === 'expo-sqlite') return { openDatabaseSync(name) {
      if (!databases.has(name)) {
        const database = new DatabaseSync(path.join(directory, `${databaseId}-${name}`));
        database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');
        allDatabases.push(database);
        databases.set(name, {
          runAsync: async (sql, params) => database.prepare(sql).run(...params),
          getFirstAsync: async (sql, params) => database.prepare(sql).get(...params),
          getAllAsync: async (sql, params) => database.prepare(sql).all(...params),
        });
      }
      return databases.get(name);
    } };
    return rootRequire(name);
  };
  const storage = { resetAllData: async () => { resetCalls++; } };
  const Service = new Function('require', 'BareWorkletApi', 'WdkSecretManagerStorage',
    'AssetTicker', 'NetworkType', 'isArkadeNetwork', 'Decimal', `${serviceCode};return Service`)(
    shimRequire, { hrpcInstances: { wdkManager: rpc } }, storage,
    types.AssetTicker, types.NetworkType, types.isArkadeNetwork, sampleRequire('decimal.js'));
  const service = new Service();
  service.walletManagerCache = new Map();
  service.arkadeBalanceListeners = [];
  service.retrieveSeed = async () => seed;
  service.setConfig({ indexer: { apiKey: '', url: '', version: '' }, chains: { arkade: {
    arkServerUrl: operator, indexerUrl: operator,
    onchainProvider: new sdk.EsploraProvider(esploraUrl),
    emulator: new sdk.RestEmulatorProvider(emulatorUrl),
    settlementConfig: false,
    solver: { discovery: { registryUrl } },
    lnurl: { baseUrl: lnurlUrl, domain },
  } } });
  services.push({ service, clientStream, serverStream, resetCalls: () => resetCalls });
  return service;
}

async function docker(name, ...args) {
  return (await run('docker', ['exec', `${prefix}${name}`, ...args], { timeout: 120000, maxBuffer: 2 ** 20 })).stdout;
}
async function until(check, label) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out: ${label}`);
}
function report(step, data) { console.log(JSON.stringify({ step, ...data }, (_, value) => typeof value === 'bigint' ? value.toString() : value)); }

(async () => {
  const info = await (await fetch(`${operator}/v1/info`)).json();
  assert.equal(info.network, 'regtest', 'This test only spends regtest coins');
  const senderSeed = sampleRequire('bip39').entropyToMnemonic(randomBytes(16).toString('hex'));
  const sender = makeService(senderSeed);
  const receiver = makeService(sampleRequire('bip39').entropyToMnemonic(randomBytes(16).toString('hex')));
  try {
    await sender.createWallet({ walletName: 'regtest-sender', prf: 'fixture-keychain' });
    await receiver.createWallet({ walletName: 'regtest-receiver', prf: 'fixture-keychain' });
    assert.ok(sender.arkadeAccount && receiver.arkadeAccount, 'actual source initialization must succeed');
    const from = await sender.arkadeAccount.getAddress();
    const to = await receiver.arkadeAccount.getAddress();
    report('sample-services-created', { from, to, directory });
    await docker('arkd', 'ark', 'send', '--to', from, '--amount', '50000', '--password', 'secret');
    await until(async () => (await sender.arkadeAccount.getBalance()) >= 50000n, 'sample sender funding');
    const quoted = await sender.quoteSendByNetwork(types.NetworkType.ARKADE, 0, 0.00001, to, types.AssetTicker.BTC);
    assert.equal(quoted, 0);
    const sent = await sender.sendByNetwork(types.NetworkType.ARKADE, 0, 0.00001, to, types.AssetTicker.BTC);
    await until(async () => (await receiver.arkadeAccount.getBalance()) === 1000n, 'sample direct receive');
    report('sample-direct-send', { hash: sent.hash, fee: sent.fee, receiveSats: 1000 });
    const reusable = await receiver.getLnurlReceiver();
    assert.ok(reusable.lnurl.startsWith('LNURL1'));
    const same = await receiver.getLnurlReceiver();
    assert.equal(same.lnurl, reusable.lnurl);
    const lnurl = await sender.sendByNetwork(types.NetworkType.ARKADE, 0, 0.00001, reusable.lnurl, types.AssetTicker.BTC);
    await until(async () => (await receiver.arkadeAccount.getBalance()) === 2000n, 'sample LNURL receive');
    report('sample-reusable-lnurl', { lightningAddress: reusable.lightningAddress, hash: lnurl.hash, receiveSats: 1000 });
    const markets = await sender.getSwapMarkets();
    assert.ok(markets.length > 0);
    report('sample-nostr-markets', { markets: markets.map(m => m.key) });
    const incoming = await receiver.createLightningInvoice(2000);
    assert.ok(incoming.invoice && incoming.paymentHash);
    await docker('lnd-peer', 'lncli', '--network=regtest', 'payinvoice', '--force', '--json', incoming.invoice);
    await until(async () => (await receiver.arkadeAccount.getBalance()) === 4000n, 'sample Lightning receive');
    report('sample-lightning-receive', { paymentHash: incoming.paymentHash, receiveSats: 2000 });
    const invoice = JSON.parse(await docker('lnd-peer', 'lncli', '--network=regtest', 'addinvoice', '--amt=1000', '--memo=WDK-sample-E2E'));
    const paid = await sender.sendByNetwork(types.NetworkType.LIGHTNING, 0, 0.00001, invoice.payment_request, types.AssetTicker.BTC);
    report('sample-lightning-send', { hash: paid.hash, fee: paid.fee });
    const retainedBalance = await sender.arkadeAccount.getBalance();
    await Promise.all(services.map(async entry => {
      await entry.service.clearWallet();
      assert.equal(entry.resetCalls(), 1);
      assert.equal(entry.service.arkadeAccount, null);
    }));
    report('sample-clear-wallet', { services: services.length });
    const replacement = makeService(sampleRequire('bip39').entropyToMnemonic(randomBytes(16).toString('hex')), 0);
    await replacement.createWallet({ walletName: 'new-seed', prf: 'fixture-keychain' });
    assert.notEqual(await replacement.arkadeAccount.getAddress(), from);
    assert.equal(await replacement.arkadeAccount.getBalance(), 0n);
    assert.deepEqual(await replacement.arkadeAccount.getTransactionHistory(), []);
    await replacement.clearWallet();
    const restored = makeService(senderSeed, 0);
    await restored.createWallet({ walletName: 'restored-seed', prf: 'fixture-keychain' });
    assert.equal(await restored.arkadeAccount.getAddress(), from);
    assert.equal(await restored.arkadeAccount.getBalance(), retainedBalance);
    assert.ok((await restored.arkadeAccount.getTransactionHistory()).some(tx => Object.values(tx.key).includes(sent.hash)));
    await restored.clearWallet();
    report('sample-seed-isolation', { newSeedBalance: 0n, restoredBalance: retainedBalance });
  } finally {
    const closed = await Promise.allSettled(services.map(async entry => {
      await entry.service.arkadeManager?.dispose();
      await entry.service.wdkManager?.workletStop({});
    }));
    for (const entry of services) { entry.clientStream.destroy(); entry.serverStream.destroy(); }
    closeSharedNostrPool();
    for (const database of allDatabases) database.close();
    const failed = closed.filter(result => result.status === 'rejected');
    if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Sample teardown failed');
    report('sample-teardown-complete', { directory });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
