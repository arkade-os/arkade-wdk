import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ArkAddress, makeHandle } from '@arkade-os/sdk';
import { MaximumFeeExceededError } from '@tetherto/wdk-wallet';
import { createPaymentRouter, quoteSend, send } from '../lib/send.js';

const address = new ArkAddress(
  new Uint8Array(32).fill(1),
  new Uint8Array(32).fill(2),
  'tark'
).encode();
const destination = 'bc1qh96eg54ddu4q2cmn0n6g8uymuqlw402jndphu9';
const fees = {
  intentFee: { offchainInput: '200.0', offchainOutput: '50.0', onchainOutput: '100.0' },
};

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
