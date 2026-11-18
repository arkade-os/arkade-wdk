import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, ArkAddress, SingleKey, RestOperatorProvider } from '@arkade-os/sdk';
import { InMemoryAssetSwapRepository } from '@arkade-os/swap';
import { MaximumFeeExceededError } from '@tetherto/wdk-wallet';
import WalletManagerArkade from '../wallet-manager-arkade.js';
import { WalletAccountArkade } from '../wallet-account-arkade.js';

const seed = new Uint8Array(32).fill(7);
const address = new ArkAddress(
  new Uint8Array(32).fill(1),
  new Uint8Array(32).fill(2),
  'ark'
).encode();
const identity = SingleKey.fromPrivateKey(new Uint8Array(32).fill(3));
const info = { network: 'bitcoin', fees: { txFeeRate: '1' } };
const wallet = () => ({
  identity,
  getContractManager: async () => ({ getUnsupportedContracts: async () => [] }),
  getAddress: async () => address,
  getBoardingAddress: async () => 'bc1boarding',
  dispose: mock.fn(async () => {}),
});
afterEach(() => mock.restoreAll());

function account(config = {}) {
  return new WalletAccountArkade(
    address,
    "m/86'/0'/0'/0/0",
    wallet(),
    { privateKey: new Uint8Array(32).fill(4), publicKey: new Uint8Array(33) },
    {},
    Promise.resolve(info),
    { config }
  );
}

describe('payment lifetime and fee limits', () => {
  it(
    'keeps the wallet and key alive after a caller timeout until native execution ends',
    { timeout: 2000 },
    async () => {
      const a = account({ paymentTimeoutMs: 5 });
      let finish;
      a._wallet.send = mock.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      );
      await assert.rejects(a.sendTransaction({ to: address, value: 1000n }), /settle timeout/);
      const disposing = a.dispose();
      let disposed = false;
      void disposing.then(() => {
        disposed = true;
      });
      try {
        await new Promise(setImmediate);
        assert.equal(disposed, false);
        assert.equal(a._wallet.dispose.mock.callCount(), 0);
        assert.ok(a.keyPair.privateKey.every((byte) => byte === 4));
      } finally {
        finish('late-ark-tx');
        await disposing;
      }
      await a.dispose();
      assert.equal(a._wallet.send.mock.callCount(), 1);
      assert.equal(a._wallet.dispose.mock.callCount(), 1);
      assert.ok(a.keyPair.privateKey.every((byte) => byte === 0));
    }
  );

  for (const [method, config, request] of [
    ['sendTransaction', { transactionMaxFee: 0n }, { to: address, value: 1000n }],
    ['transfer', { transferMaxFee: 0n }, { recipient: address, token: 'asset', amount: 100n }],
  ]) {
    it(`enforces ${method} maximum fees before spending`, async () => {
      const a = account(config);
      const execute = mock.fn();
      a._paymentRouter = {
        route: async (req) => ({ amount: req.amount ?? 330, fee: 1, total: 1001, send: execute }),
      };
      await assert.rejects(a[method](request), MaximumFeeExceededError);
      assert.equal(execute.mock.callCount(), 0);
      await a.dispose();
    });
  }

  it('cancels a pending quote on disposal and never executes its late result', async () => {
    const a = account();
    let resolveQuote;
    a._paymentRouter = {
      route: () =>
        new Promise((resolve) => {
          resolveQuote = resolve;
        }),
    };
    const execute = mock.fn();
    const sending = a.sendTransaction({ to: address, value: 1000n });
    const rejected = assert.rejects(sending, /disposed/);
    await a.dispose();
    resolveQuote({ amount: 1000, fee: 0, send: execute });
    await rejected;
    assert.equal(execute.mock.callCount(), 0);
    assert.ok(a.keyPair.privateKey.every((byte) => byte === 0));
  });

  it('drains a payment that started execution before wiping its key', async () => {
    const a = account();
    let finish;
    const settled = new Promise((resolve) => {
      finish = resolve;
    });
    let started;
    const executing = new Promise((resolve) => {
      started = resolve;
    });
    a._paymentRouter = {
      route: async () => ({
        amount: 1000,
        fee: 0,
        send: async () => {
          started();
          return { settled: () => settled };
        },
      }),
    };
    const sending = a.sendTransaction({ to: address, value: 1000n });
    await executing;
    const disposing = a.dispose();
    assert.ok(a.keyPair.privateKey.every((byte) => byte === 4));
    finish({ txid: 'funded-tx' });
    assert.deepEqual(await sending, { hash: 'funded-tx', fee: 0n });
    await disposing;
    assert.ok(a.keyPair.privateKey.every((byte) => byte === 0));
  });
});

describe('manager integration', () => {
  it('lets the SDK resolve a configured service including its emulator', async () => {
    mock.method(RestOperatorProvider.prototype, 'getInfo', async () => info);
    const create = mock.method(Wallet, 'create', async () => wallet());
    const service = {
      operatorUrl: 'http://localhost:57020',
      emulatorUrl: 'http://localhost:57023',
    };
    const manager = new WalletManagerArkade(seed.slice(), { service });
    await manager.getAccount();
    const config = create.mock.calls[0].arguments[0];
    assert.deepEqual(config.service, service);
    assert.equal(config.operatorProvider, undefined);
    assert.equal(config.indexerProvider, undefined);
    await manager.dispose();
  });
  it('keeps the minimum client build rejection actionable without retrying', async () => {
    const getInfo = mock.fn(async () => {
      throw new Error(
        JSON.stringify({
          details: [
            {
              '@type': 'type.googleapis.com/ark.v1.ErrorDetails',
              code: 9,
              name: 'BUILD_VERSION_TOO_OLD',
              message: 'old client',
              metadata: { min_version: '0.5.6' },
            },
          ],
        })
      );
    });
    const manager = new WalletManagerArkade(seed.slice(), { operatorProvider: { getInfo } });
    await assert.rejects(manager.getAccount(), /minimum 0.5.6.*Update @arkade-os\/sdk/);
    assert.equal(getInfo.mock.callCount(), 1);
    await manager.dispose();
  });
  it('shares one account for concurrent requests and forwards fee limits', async () => {
    const create = mock.method(Wallet, 'create', async () => wallet());
    const manager = new WalletManagerArkade(seed.slice(), {
      arkProvider: { getInfo: async () => info },
      transactionMaxFee: 50n,
    });
    const [first, second] = await Promise.all([manager.getAccount(0), manager.getAccount(0)]);
    assert.equal(first, second);
    assert.equal(create.mock.callCount(), 1);
    assert.equal(first.config.transactionMaxFee, 50n);
    assert.equal(first.getLnurl().domain, 'arkade.money');
    await manager.dispose();
  });

  it('resolves persistent wallet storage separately for each cached account path', async () => {
    const create = mock.method(Wallet, 'create', async () => wallet());
    const storage = mock.fn((path) => ({ walletRepository: { namespace: path } }));
    const manager = new WalletManagerArkade(seed.slice(), {
      operatorProvider: { getInfo: async () => info },
      storage,
    });
    await Promise.all([manager.getAccount(0), manager.getAccount(1), manager.getAccount(0)]);
    assert.equal(storage.mock.callCount(), 2);
    assert.deepEqual(
      create.mock.calls
        .map(({ arguments: [config] }) => config.storage.walletRepository.namespace)
        .sort(),
      ["m/86'/0/0'/0/0", "m/86'/0/0'/0/1"]
    );
    await manager.dispose();
  });

  it('selects the mutinynet LNURL domain without registering an address', async () => {
    mock.method(Wallet, 'create', async () => wallet());
    const fetch = mock.method(globalThis, 'fetch', () => {
      throw new Error('No receive registration expected');
    });
    const manager = new WalletManagerArkade(seed.slice(), {
      arkProvider: { getInfo: async () => ({ ...info, network: 'mutinynet' }) },
    });
    const a = await manager.getAccount();
    assert.equal(a.getLnurl().domain, 'lnurl.mutinynet.arkade.sh');
    assert.equal(fetch.mock.callCount(), 0);
    await manager.dispose();
  });

  it('waits for the swap repository restore and cleans up a failed account', async () => {
    const w = wallet();
    mock.method(Wallet, 'create', async () => w);
    const repository = new InMemoryAssetSwapRepository();
    mock.method(repository, 'getSwapRecordsPage', async () => {
      throw new Error('repository unreadable');
    });
    const manager = new WalletManagerArkade(seed.slice(), {
      arkProvider: { getInfo: async () => info },
      solver: () => ({ repository }),
    });
    await assert.rejects(manager.getAccount(), /repository unreadable/);
    assert.equal(w.dispose.mock.callCount(), 1);
    await manager.dispose();
  });
});
