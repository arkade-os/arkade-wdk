import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ArkAddress, Ramps } from '@arkade-os/sdk';
import { createPaymentRouter, createReadOnlyPaymentRouter, quoteSend, send } from '../lib/send.js';

const ARK = new ArkAddress(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), 'tark').encode();
const BTC = 'bc1qh96eg54ddu4q2cmn0n6g8uymuqlw402jndphu9';
const INVOICE =
  'lnbc15u1p3xnhl2pp5jptserfk3zk4qy42tlucycrfwxhydvlemu9pqr93tuzlv9cc7g3sdqsvfhkcap3xyhx7un8cqzpgxqzjcsp5f8c52y2stc300gl6s4xswtjpc37hrnnr3c9wvtgjfuvqmpm35evq9qyyssqy4lgd8tj637qcjp05rdpxxykjenthxftej7a2zzmwrmrl70fyj9hvj0rewhzj7jfyuwkwcg9g2jpwtk3wkjtwnkdks84hsnu8xps5vsq4gj5hs';

function wallet() {
  return {
    send: mock.fn(async () => 'ark-tx'),
    arkProvider: { getInfo: async () => ({ fees: { intentFee: { onchainOutput: '100.0' } } }) },
  };
}

function solver() {
  const quote = {
    id: 'quote-1',
    market: { kind: 'card', key: 'market-1' },
    take: { amount: 1500n },
    fee: { amount: 208n },
    give: { amount: 1708n },
  };
  const swap = { id: 'swap-1', fundingTxid: 'funding-tx' };
  return {
    resolve: mock.fn(async () => ({ eligible: 1 })),
    quote: mock.fn(async () => quote),
    accept: mock.fn(async () => swap),
    onUpdate: (callback) => {
      callback({ swap, outcome: 'paid' });
      return () => {};
    },
  };
}

afterEach(() => mock.restoreAll());

describe('SDK payment router integration', () => {
  it('quotes without spending, then sends Arkade through the SDK rail', async () => {
    const signingWallet = wallet();
    const router = createPaymentRouter(signingWallet);
    assert.deepEqual(await quoteSend({ router, to: ARK, amount: 1234n }), {
      fee: 0n,
      total: 1234n,
    });
    assert.equal(signingWallet.send.mock.callCount(), 0);
    assert.deepEqual(await send({ router, to: ARK, amount: 1234n }), { txid: 'ark-tx', fee: 0n });
    assert.deepEqual(signingWallet.send.mock.calls[0].arguments[0], {
      recipients: [{ address: ARK, amount: 1234 }],
      maxChangeFee: 0,
    });
  });

  it('keeps the SDK asset carrier and zero offchain fee', async () => {
    const signingWallet = wallet();
    const router = createPaymentRouter(signingWallet);
    const assets = [{ assetId: 'a'.repeat(64), amount: 500n }];
    await send({ router, to: ARK, amount: 0n, assets });
    assert.deepEqual(signingWallet.send.mock.calls[0].arguments[0], {
      recipients: [{ address: ARK, amount: 330, assets }],
      maxChangeFee: 0,
    });
  });

  it('uses BIP21 amount and prefers Arkade over Lightning fallback', async () => {
    const signingWallet = wallet();
    mock.method(globalThis, 'fetch', async () => {
      throw new Error('unexpected LNURL fetch');
    });
    const router = createPaymentRouter(signingWallet);
    await send({
      router,
      to: `bitcoin:${BTC}?ark=${ARK}&amount=0.00001&lightning=lnurl1unused`,
      amount: 0n,
    });
    assert.deepEqual(signingWallet.send.mock.calls[0].arguments[0], {
      recipients: [{ address: ARK, amount: 1000 }],
      maxChangeFee: 0,
    });
  });

  it('refuses a conflicting URI amount before quoting or spending', async () => {
    const route = mock.fn();
    await assert.rejects(
      send({ router: { route }, to: `bitcoin:${BTC}?amount=0.00001`, amount: 2000n }),
      /Amount mismatch/
    );
    assert.equal(route.mock.callCount(), 0);
  });

  it('refuses unsafe and negative bigint amounts before routing', async () => {
    const route = mock.fn();
    for (const amount of [-1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n]) {
      await assert.rejects(send({ router: { route }, to: ARK, amount }), /safe integer/);
    }
    assert.equal(route.mock.callCount(), 0);
  });

  it('offboards onchain with the SDK fee schedule instead of sending to a BTC address', async () => {
    const signingWallet = wallet();
    const offboard = mock.method(Ramps.prototype, 'offboardExact', async () => 'bitcoin-tx');
    const router = createPaymentRouter(signingWallet);
    assert.deepEqual(await send({ router, to: BTC, amount: 1000n }), {
      txid: 'bitcoin-tx',
      fee: 100n,
    });
    assert.equal(signingWallet.send.mock.callCount(), 0);
    assert.equal(offboard.mock.calls[0].arguments[0].amount, 1000n);
  });

  it('quotes a read-only wallet without adding signing methods', async () => {
    const readonly = {};
    const router = createReadOnlyPaymentRouter(readonly, Promise.resolve({ fees: {} }));
    assert.deepEqual(await quoteSend({ router, to: ARK, amount: 1000n }), {
      fee: 0n,
      total: 1000n,
    });
    assert.equal(readonly.send, undefined);
  });

  it('uses the shared solver rail and awaits its terminal settlement', async () => {
    const client = solver();
    const router = createPaymentRouter(wallet(), { solver: client });
    assert.deepEqual(await send({ router, to: INVOICE, amount: 1500n }), {
      txid: 'funding-tx',
      fee: 208n,
    });
    assert.deepEqual(client.quote.mock.calls[0].arguments[0], { to: INVOICE });
    assert.equal(client.accept.mock.callCount(), 1);
  });

  it('rejects an explicit amount that conflicts with the Lightning invoice', async () => {
    const client = solver();
    const router = createPaymentRouter(wallet(), { solver: client });
    await assert.rejects(send({ router, to: INVOICE, amount: 1499n }), /invoice is for 1500 sats/);
    assert.equal(client.accept.mock.callCount(), 0);
  });

  it('prefers a BIP21 Lightning invoice over the onchain address', async () => {
    const client = solver();
    const router = createPaymentRouter(wallet(), { solver: client });
    const result = await send({
      router,
      to: `bitcoin:${BTC}?lightning=${INVOICE}&amount=0.000015`,
      amount: 0n,
    });
    assert.equal(result.txid, 'funding-tx');
    assert.equal(client.accept.mock.callCount(), 1);
  });

  it('rejects an invoice whose amount conflicts with the BIP21 amount', async () => {
    const client = solver();
    const router = createPaymentRouter(wallet(), { solver: client });
    await assert.rejects(
      send({ router, to: `bitcoin:${BTC}?lightning=${INVOICE}&amount=0.00002`, amount: 0n }),
      /Amount mismatch/
    );
    assert.equal(client.accept.mock.callCount(), 0);
  });

  it('refuses Lightning when no solver was configured', async () => {
    const router = createPaymentRouter(wallet());
    await assert.rejects(send({ router, to: INVOICE, amount: 1500n }), /no rail/i);
  });

  it('refuses asset transfers to targets whose LNURL rails could only send BTC', async () => {
    const router = createPaymentRouter(wallet());
    await assert.rejects(
      send({
        router,
        to: 'alice@example.com',
        amount: 0n,
        assets: [{ assetId: 'a'.repeat(64), amount: 1n }],
      }),
      /Asset transfers require an Arkade address/
    );
  });

  it('does not retry a route whose execution fails', async () => {
    const execute = mock.fn(async () => {
      throw new Error('funding failed');
    });
    const route = mock.fn(async () => ({ amount: 1000, fee: 2, send: execute }));
    await assert.rejects(send({ router: { route }, to: ARK, amount: 1000n }), /funding failed/);
    assert.equal(route.mock.callCount(), 1);
    assert.equal(execute.mock.callCount(), 1);
  });
});

describe('LNURL client routing', () => {
  function endpoint(answer, options, amount = '1500000') {
    mock.method(globalThis, 'fetch', async (url) => {
      const href = new URL(url);
      if (href.pathname === '/.well-known/lnurlp/alice') {
        return Response.json({
          tag: 'payRequest',
          callback: 'https://example.com/callback',
          minSendable: 1000,
          maxSendable: 2_000_000,
          metadata: '[]',
          ...(options ? { paymentOptions: options } : {}),
        });
      }
      assert.equal(href.pathname, '/callback');
      assert.equal(href.searchParams.get('amount'), amount);
      return Response.json(answer);
    });
  }

  it('pays an advertised Arkade destination without configuring Lightning', async () => {
    endpoint({ paymentOption: 'arkade', paymentDestination: ARK }, [
      { id: 'arkade', type: 'arkade' },
    ]);
    const signingWallet = wallet();
    const router = createPaymentRouter(signingWallet);
    assert.deepEqual(await send({ router, to: 'alice@example.com', amount: 1500n }), {
      txid: 'ark-tx',
      fee: 0n,
    });
    assert.deepEqual(signingWallet.send.mock.calls[0].arguments[0], {
      recipients: [{ address: ARK, amount: 1500 }],
      maxChangeFee: 0,
    });
  });

  it('fetches and pays a BOLT11 through the shared LNURL client', async () => {
    endpoint({ pr: INVOICE });
    const client = solver();
    const router = createPaymentRouter(wallet(), { solver: client });
    assert.deepEqual(await send({ router, to: 'alice@example.com', amount: 1500n }), {
      txid: 'funding-tx',
      fee: 208n,
    });
  });

  it('resolves a Lightning address embedded in BIP21', async () => {
    endpoint({ paymentOption: 'arkade', paymentDestination: ARK }, [
      { id: 'arkade', type: 'arkade' },
    ]);
    const router = createPaymentRouter(wallet());
    assert.deepEqual(
      await send({
        router,
        to: `bitcoin:${BTC}?lightning=alice%40example.com&amount=0.000015`,
        amount: 0n,
      }),
      { txid: 'ark-tx', fee: 0n }
    );
  });

  it('refuses an LNURL callback invoice for a different amount before spending', async () => {
    endpoint({ pr: INVOICE }, undefined, '1000000');
    const client = solver();
    const router = createPaymentRouter(wallet(), { solver: client });
    await assert.rejects(
      send({ router, to: 'alice@example.com', amount: 1000n }),
      /not the requested 1000000/
    );
    assert.equal(client.accept.mock.callCount(), 0);
  });
});
