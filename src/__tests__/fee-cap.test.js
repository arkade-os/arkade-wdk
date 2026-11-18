import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ArkAddress, DefaultVtxo, SingleKey, Wallet, makeHandle } from '@arkade-os/sdk';
import { InMemoryAssetSwapRepository } from '@arkade-os/swap';
import { MaximumFeeExceededError } from '@tetherto/wdk-wallet';
import { createPaymentRouter, quoteSend, send, withZeroChangeFee } from '../lib/send.js';
import WalletManagerArkade from '../wallet-manager-arkade.js';

const address = new ArkAddress(
  new Uint8Array(32).fill(1),
  new Uint8Array(32).fill(2),
  'tark'
).encode();
const destination = 'bc1qh96eg54ddu4q2cmn0n6g8uymuqlw402jndphu9';
const fees = {
  intentFee: { offchainInput: '200.0', offchainOutput: '50.0', onchainOutput: '100.0' },
};
const invoice =
  'lnbc15u1p3xnhl2pp5jptserfk3zk4qy42tlucycrfwxhydvlemu9pqr93tuzlv9cc7g3sdqsvfhkcap3xyhx7un8cqzpgxqzjcsp5f8c52y2stc300gl6s4xswtjpc37hrnnr3c9wvtgjfuvqmpm35evq9qyyssqy4lgd8tj637qcjp05rdpxxykjenthxftej7a2zzmwrmrl70fyj9hvj0rewhzj7jfyuwkwcg9g2jpwtk3wkjtwnkdks84hsnu8xps5vsq4gj5hs';

function wallet() {
  const coins = [1100, 1000].map((value, vout) => ({
    txid: 'a'.repeat(64),
    vout,
    value,
    script: '5120' + '01'.repeat(32),
    createdAt: new Date('2026-01-01'),
    status: { confirmed: true },
    isUnrolled: false,
  }));
  return {
    getSpendableVtxos: mock.fn(async () => coins),
    getAddress: async () => address,
    arkProvider: { getInfo: async () => ({ fees }) },
    dustAmount: 330,
    settle: mock.fn(async () => 'exit-tx'),
  };
}

afterEach(() => mock.restoreAll());

async function nativeWallet(values = [1100], assets) {
  const identity = SingleKey.fromPrivateKey(new Uint8Array(32).fill(3));
  const serverPubKey = await SingleKey.fromPrivateKey(new Uint8Array(32).fill(9)).xOnlyPublicKey();
  const script = new DefaultVtxo.Script({
    pubKey: await identity.xOnlyPublicKey(),
    serverPubKey,
    csvTimelock: { type: 'blocks', value: 144n },
  });
  const target = script.address('tark', serverPubKey).encode();
  const source = Object.create(Wallet.prototype);
  Object.assign(source, {
    _offchainTapscript: script,
    _arkServerPublicKey: serverPubKey,
    _deprecatedSigners: new Map(),
    network: { hrp: 'tark' },
    dustAmount: 330n,
    arkProvider: { getInfo: async () => ({ vtxoMinAmount: 330n }) },
    getSpendableVtxos: mock.fn(async () =>
      values.map((value, vout) => ({
        txid: 'a'.repeat(64),
        vout,
        value,
        script: '5120' + '01'.repeat(32),
        createdAt: new Date('2026-01-01'),
        status: { confirmed: true },
        isUnrolled: false,
        ...(assets ? { assets } : {}),
      }))
    ),
    _withTxLock: async (execute) => execute(),
    _submitOffchainSpend: mock.fn(async () => 'ark-tx'),
  });
  return { source, target };
}

describe('zero-fee native Arkade sends', () => {
  it('rejects unavoidable native change fees before submission even with a higher cap', async () => {
    for (const maxFee of [undefined, 0n, 100n]) {
      const { source, target } = await nativeWallet();
      const router = createPaymentRouter(source);
      assert.deepEqual(await quoteSend({ router, to: target, amount: 1000n, maxFee }), {
        fee: 0n,
        total: 1000n,
      });
      await assert.rejects(
        send({ router, to: target, amount: 1000n, maxFee }),
        /Cannot form minimum change amount/
      );
      assert.equal(source._submitOffchainSpend.mock.callCount(), 0);
      assert.equal(source.getSpendableVtxos.mock.callCount(), 1);
      assert.equal(source.send, Wallet.prototype.send);
    }
  });

  it('lets SDK selection add inputs for zero-fee spendable change', async () => {
    const { source, target } = await nativeWallet([1100, 330]);
    assert.deepEqual(
      await send({ router: createPaymentRouter(source), to: target, amount: 1000n, maxFee: 0n }),
      { txid: 'ark-tx', fee: 0n }
    );
    assert.equal(source._submitOffchainSpend.mock.callCount(), 1);
    const [inputs, outputs] = source._submitOffchainSpend.mock.calls[0].arguments;
    assert.equal(
      inputs.reduce((sum, coin) => sum + BigInt(coin.value), 0n),
      1430n
    );
    assert.deepEqual(
      outputs.map((output) => output.amount),
      [1000n, 430n]
    );
  });

  it('preserves explicit SDK input selection while prohibiting change fees', async () => {
    const { source, target } = await nativeWallet();
    const router = createPaymentRouter(source);
    const quote = await router.route({
      raw: target,
      amount: 1000,
      selectedVtxos: await source.getSpendableVtxos(),
    });
    const handle = await quote.send();
    await assert.rejects(handle.settled(), /change is below the operator minimum/);
    assert.equal(source.getSpendableVtxos.mock.callCount(), 1);
    assert.equal(source._submitOffchainSpend.mock.callCount(), 0);
  });

  it('applies the same native change policy to asset carriers', async () => {
    const assets = [{ assetId: 'a'.repeat(68), amount: 100n }];
    const { source, target } = await nativeWallet([430], assets);
    await assert.rejects(
      send({ router: createPaymentRouter(source), to: target, amount: 0n, assets, maxFee: 0n }),
      /Cannot form minimum change amount/
    );
    assert.equal(source._submitOffchainSpend.mock.callCount(), 0);
    assert.equal(assets[0].amount, 100n);
  });

  it('also guards the native rail composed inside the LNURL client', async () => {
    const { source, target } = await nativeWallet();
    mock.method(globalThis, 'fetch', async (url) =>
      Response.json(
        new URL(url).pathname === '/callback'
          ? { paymentOption: 'arkade', paymentDestination: target }
          : {
              tag: 'payRequest',
              callback: 'https://example.com/callback',
              minSendable: 1000,
              maxSendable: 2_000_000,
              metadata: '[]',
              paymentOptions: [{ id: 'arkade', type: 'arkade' }],
            }
      )
    );
    await assert.rejects(
      send({
        router: createPaymentRouter(source),
        to: 'alice@example.com',
        amount: 1000n,
        maxFee: 0n,
      }),
      /Cannot form minimum change amount/
    );
    assert.equal(source._submitOffchainSpend.mock.callCount(), 0);
  });
});

describe('solver funding change fees', () => {
  it('preserves native method receivers and SDK funding bounds without changing the wallet', async () => {
    class Context {
      #address = address;
      get dustAmount() {
        return this.#address.length;
      }
      getAddress() {
        return this.#address;
      }
      send(params) {
        assert.equal(this.#address, address);
        return params;
      }
    }
    const source = new Context();
    const guarded = withZeroChangeFee(source);
    const params = {
      recipients: [{ address, amount: 1708 }],
      selectedVtxos: [{ txid: 'a'.repeat(64), vout: 0 }],
      validUntil: Math.floor(Date.now() / 1000) + 60,
      inputExpiryFloor: { kind: 'time', value: 2_000_000_000n },
      maxChangeFee: 100,
    };
    assert.equal(await guarded.getAddress(), address);
    assert.equal(guarded.dustAmount, address.length);
    assert.deepEqual(guarded.send(params), { ...params, maxChangeFee: 0 });
    assert.equal(guarded.send(params).selectedVtxos, params.selectedVtxos);
    assert.equal(params.maxChangeFee, 100);
    assert.equal(source.send, Context.prototype.send);
    assert.deepEqual(guarded.send(...params.recipients), {
      recipients: params.recipients,
      maxChangeFee: 0,
    });
  });

  async function fundingWallet(values) {
    const { source, target } = await nativeWallet(values);
    const info = {
      network: 'regtest',
      fees: { txFeeRate: '1' },
      signerPubkey: Buffer.from(source._arkServerPublicKey).toString('hex'),
      deprecatedSigners: [],
    };
    Object.assign(source, {
      identity: SingleKey.fromPrivateKey(new Uint8Array(32).fill(3)),
      getAddress: async () => target,
      getArkadeInfo: async () => info,
      getTransactionHistory: async () => [],
      getContractManager: async () => ({ getUnsupportedContracts: async () => [] }),
      dispose: mock.fn(async () => {}),
    });
    mock.method(Wallet, 'create', async () => source);
    const manager = new WalletManagerArkade(new Uint8Array(32).fill(7), {
      arkProvider: { getInfo: async () => info },
      solver: () => ({
        repository: new InMemoryAssetSwapRepository(),
        policy: { drive: 'readonly' },
      }),
    });
    const account = await manager.getAccount();
    let accepted;
    const client = {
      resolve: async () => ({ eligible: 1 }),
      quote: async () => ({
        id: 'funding-quote',
        market: { kind: 'card', key: 'market-1' },
        take: { amount: 1500n },
        fee: { amount: 208n },
        give: { amount: 1708n },
      }),
      accept: mock.fn(async () => {
        const payment = await account.swapClient.pay(target, { amount: 1708n });
        accepted = { id: 'funding-swap', fundingTxid: payment.txid };
        return accepted;
      }),
      onUpdate: (callback) => {
        callback({ swap: accepted, outcome: 'paid' });
        return () => {};
      },
    };
    return {
      source,
      manager,
      account,
      client,
      router: createPaymentRouter(source, { solver: client }),
    };
  }

  it('guards the manager swap client before dust can exceed a Lightning fee cap', async () => {
    const { source, manager, account, client, router } = await fundingWallet([1808]);
    try {
      await assert.rejects(
        send({ router, to: invoice, amount: 1500n, maxFee: 208n }),
        /Cannot form minimum change amount/
      );
      assert.equal(source._submitOffchainSpend.mock.callCount(), 0);
      assert.equal(client.accept.mock.callCount(), 1);
      assert.equal(account._wallet, source);
      assert.equal(source.send, Wallet.prototype.send);
    } finally {
      await manager.dispose();
    }
    assert.equal(source.dispose.mock.callCount(), 1);
  });

  it('funds once at the quoted Lightning fee when SDK selection can preserve change', async () => {
    const { source, manager, client, router } = await fundingWallet([1808, 330]);
    try {
      assert.deepEqual(await send({ router, to: invoice, amount: 1500n, maxFee: 208n }), {
        txid: 'ark-tx',
        fee: 208n,
      });
      const [inputs, outputs] = source._submitOffchainSpend.mock.calls[0].arguments;
      assert.equal(
        inputs.reduce((sum, coin) => sum + BigInt(coin.value), 0n) -
          outputs.reduce((sum, output) => sum + output.amount, 0n),
        0n
      );
      assert.equal(client.accept.mock.callCount(), 1);
      assert.equal(source._submitOffchainSpend.mock.callCount(), 1);
    } finally {
      await manager.dispose();
    }
  });
});

describe('onchain fee caps', () => {
  it('adds another SDK-selected input when the first selection leaves dust change', async () => {
    const source = wallet();
    const coins = await source.getSpendableVtxos();
    coins[0].value = 1430;
    assert.deepEqual(
      await send({
        router: createPaymentRouter(source),
        to: destination,
        amount: 1000n,
        maxFee: 550n,
      }),
      { txid: 'exit-tx', fee: 550n }
    );
    const { inputs, outputs } = source.settle.mock.calls[0].arguments[0];
    assert.deepEqual(
      inputs.map((coin) => coin.vout),
      [0, 1]
    );
    assert.equal(outputs[1].amount, 880n);
    assert.equal(source.settle.mock.callCount(), 1);
  });

  it('leaves asset-bearing outputs untouched when selecting BTC exit inputs', async () => {
    const source = wallet();
    const plain = await source.getSpendableVtxos();
    const tagged = {
      ...plain[0],
      vout: 2,
      value: 5000,
      assets: [{ assetId: 'asset-id', amount: 100n }],
    };
    let unspent = [tagged, ...plain];
    source.getSpendableVtxos.mock.mockImplementation(async () => unspent);
    source.settle.mock.mockImplementation(async ({ inputs }) => {
      const spent = new Set(inputs.map((coin) => coin.vout));
      unspent = unspent.filter((coin) => !spent.has(coin.vout));
      return 'exit-tx';
    });
    const assetBalance = () =>
      unspent.flatMap((coin) => coin.assets ?? []).reduce((sum, asset) => sum + asset.amount, 0n);
    assert.equal(assetBalance(), 100n);
    await send({
      router: createPaymentRouter(source),
      to: destination,
      amount: 1000n,
      maxFee: 550n,
    });
    assert.deepEqual(
      source.settle.mock.calls[0].arguments[0].inputs.map((coin) => coin.vout),
      [0, 1]
    );
    assert.equal(assetBalance(), 100n);
    assert.equal(unspent[0], tagged);
  });

  it('refuses a BTC exit when only asset-bearing outputs could fund it', async () => {
    const source = wallet();
    const tagged = {
      ...(await source.getSpendableVtxos())[0],
      value: 5000,
      assets: [{ assetId: 'asset-id', amount: 100n }],
    };
    source.getSpendableVtxos.mock.mockImplementation(async () => [tagged]);
    await assert.rejects(
      send({ router: createPaymentRouter(source), to: destination, amount: 1000n, maxFee: 550n }),
      /Insufficient funds/
    );
    assert.equal(source.settle.mock.callCount(), 0);
    assert.equal(tagged.assets[0].amount, 100n);
  });

  it('rejects the full input and change fees before settlement', async () => {
    const source = wallet();
    await assert.rejects(
      send({ router: createPaymentRouter(source), to: destination, amount: 1000n, maxFee: 300n }),
      MaximumFeeExceededError
    );
    assert.equal(source.settle.mock.callCount(), 0);
  });

  it('spends the frozen selection and reports the full fee at the cap', async () => {
    const source = wallet();
    assert.deepEqual(
      await send({
        router: createPaymentRouter(source),
        to: destination,
        amount: 1000n,
        maxFee: 550n,
      }),
      { txid: 'exit-tx', fee: 550n }
    );
    assert.equal(source.getSpendableVtxos.mock.callCount(), 1);
    assert.equal(source.settle.mock.callCount(), 1);
    const { inputs, outputs } = source.settle.mock.calls[0].arguments[0];
    assert.deepEqual(
      inputs.map((coin) => coin.vout),
      [0, 1]
    );
    assert.equal(
      inputs.reduce((sum, coin) => sum + BigInt(coin.value), 0n) -
        outputs.reduce((sum, output) => sum + output.amount, 0n),
      550n
    );
    assert.equal(outputs[0].amount, 1000n);
  });

  it('quotes the same capped fee from a BIP21 amount without spending', async () => {
    const source = wallet();
    assert.deepEqual(
      await quoteSend({
        router: createPaymentRouter(source),
        to: `bitcoin:${destination}?amount=0.00001`,
        amount: 0n,
        maxFee: 550n,
      }),
      {
        fee: 550n,
        total: 1550n,
      }
    );
    assert.equal(source.settle.mock.callCount(), 0);
  });
});

describe('payment settlement bounds', () => {
  it(
    'times out one execution with its recovery identity and never retries',
    { timeout: 2000 },
    async () => {
      const execute = mock.fn(async () =>
        makeHandle('persisted-swap', () => new Promise(() => {}))
      );
      const router = {
        route: async () => ({ railId: 'lightning', amount: 1000, fee: 2, send: execute }),
      };
      await assert.rejects(
        send({ router, to: 'invoice', amount: 1000n, paymentTimeoutMs: 5 }),
        (error) => {
          assert.match(error.message, /settle timeout/);
          assert.equal(error.paymentId, 'persisted-swap');
          assert.equal(error.railId, 'lightning');
          return true;
        }
      );
      assert.equal(execute.mock.callCount(), 1);
    }
  );

  it('validates the wait bound before routing or spending', async () => {
    const route = mock.fn();
    for (const paymentTimeoutMs of [0, -1, 0.5, Infinity, NaN, 2 ** 31]) {
      await assert.rejects(
        send({ router: { route }, to: destination, amount: 1000n, paymentTimeoutMs }),
        RangeError
      );
    }
    assert.equal(route.mock.callCount(), 0);
  });

  it('retains the original settlement error type and cause', async () => {
    const cause = new Error('operator refused');
    const failure = new TypeError('settlement failed', { cause });
    const router = {
      route: async () => ({
        railId: 'onchain',
        amount: 1000,
        fee: 0,
        send: async () => ({
          id: 'payment-2',
          settled: async () => {
            throw failure;
          },
        }),
      }),
    };
    await assert.rejects(send({ router, to: destination, amount: 1000n }), (error) => {
      assert.equal(error, failure);
      assert.equal(error.cause, cause);
      assert.equal(error.paymentId, 'payment-2');
      return true;
    });
  });
});
