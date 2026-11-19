const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createServer } = require('node:net');
const { delimiter, join } = require('node:path');
const test = require('node:test');
const HRPC = require('@tetherto/pear-wrk-wdk/hrpc');
const { default: WalletManagerArkade } = require('@arkade-os/wdk');

const fixtureA = 'abandon '.repeat(11) + 'about';
const fixtureB = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const arkServerUrl = 'http://127.0.0.1:57020';
const esploraUrl = 'http://127.0.0.1:57000/api';
const config = JSON.stringify({
  networks: { bitcoin: { blockchain: 'bitcoin', config: { network: 'regtest' } } },
  modules: { arkade: { arkServerUrl, esploraUrl } },
});

test(
  'bundled Pear worklet reads Arkade and restores its identity on regtest',
  { timeout: 45_000 },
  async () => {
    const info = await fetch(`${arkServerUrl}/v1/info`, { signal: AbortSignal.timeout(5000) });
    assert.ok(info.ok, 'Start the disposable Arkade regtest stack before running this smoke');
    assert.equal((await info.json()).network, 'regtest');

    const cwd = join(__dirname, '.wdk-bundle', 'addons');
    const env = { ...process.env };
    if (process.platform === 'linux') {
      env.LD_LIBRARY_PATH = [cwd, env.LD_LIBRARY_PATH].filter(Boolean).join(delimiter);
    } else if (process.platform === 'darwin') {
      env.DYLD_FRAMEWORK_PATH = [cwd, env.DYLD_FRAMEWORK_PATH].filter(Boolean).join(delimiter);
    }
    let phase = 'worklet handshake';
    let timer;
    const expected = new WalletManagerArkade(fixtureA, { arkServerUrl, settlementConfig: false });
    const server = createServer();
    let child;
    let done;
    let ipc;
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const connection = once(server, 'connection');
      child = spawn(
        require('bare-runtime')(),
        [
          join(__dirname, 'smoke-host.cjs'),
          join(__dirname, '.wdk-bundle', 'wdk-worklet.bundle.js'),
          String(server.address().port),
        ],
        { cwd, env, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true }
      );
      done = once(child, 'exit');
      const exited = done.then(([code, signal]) => {
        throw new Error(`Bare worklet exited early (${signal ?? code})`);
      });
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out during ${phase}`)), 30_000);
      });
      [ipc] = await Promise.race([connection, deadline, exited]);
      server.close();
      const rpc = new HRPC(ipc);
      const call = async (method) => {
        phase = `Arkade ${method}`;
        return JSON.parse((await rpc.callModule({ module: 'arkade', method })).result);
      };

      async function initialize(mnemonic) {
        phase = 'mnemonic encryption';
        const { encryptedSeedBuffer, encryptedEntropyBuffer, encryptionKey } =
          await rpc.getSeedAndEntropyFromMnemonic({ mnemonic });
        try {
          phase = 'WDK initialization';
          const reply = await rpc.initializeWDK({
            config,
            encryptedSeed: encryptedSeedBuffer,
            encryptionKey,
          });
          assert.equal(reply.status, 'initialized');
        } finally {
          encryptedSeedBuffer.fill(0);
          encryptedEntropyBuffer.fill(0);
          encryptionKey.fill(0);
        }
      }

      await Promise.race([
        deadline,
        exited,
        (async () => {
          assert.equal((await rpc.workletStart({})).status, 'started');
          await initialize(fixtureA);
          const address = await call('getAddress');
          assert.match(address, /^tark1/);
          phase = 'legacy address derivation';
          assert.equal(address, await (await expected.getAccount()).getAddress());
          const balance = await call('getBalanceDetails');
          assert.equal(BigInt(balance.total), 0n);
          assert.equal(BigInt(balance.boarding.total), 0n);
          await assert.rejects(call('sendTransaction'), /not allowed/);
          await call('close');
          await call('close');
          await assert.rejects(call('getAddress'), /disposed/);
          phase = 'Bitcoin account address';
          const btc = await rpc.callMethod({
            network: 'bitcoin',
            accountIndex: 0,
            methodName: 'getAddress',
          });
          assert.match(JSON.parse(btc.result), /^bcrt1/);
          await initialize(fixtureB);
          assert.notEqual(await call('getAddress'), address);
          await initialize(fixtureA);
          assert.equal(await call('getAddress'), address);
          await call('close');
        })(),
      ]);
    } finally {
      clearTimeout(timer);
      if (server.listening) server.close();
      ipc?.end();
      const killIfStuck = setTimeout(() => child?.kill(), 5000).unref();
      try {
        await Promise.all([expected.dispose(), done]);
      } finally {
        clearTimeout(killIfStuck);
      }
    }
    assert.deepEqual(await done, [0, null]);
  }
);
