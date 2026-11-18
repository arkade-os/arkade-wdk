import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { withAbort } from '../lib/abort.js';
import { send } from '../lib/send.js';
import { WalletAccountArkade } from '../wallet-account-arkade.js';

class BasicSignal extends EventTarget {
  aborted = false;
  listeners = new Set();

  addEventListener(type, listener, options) {
    if (type === 'abort') this.listeners.add(listener);
    super.addEventListener(type, listener, options);
  }

  removeEventListener(type, listener, options) {
    if (type === 'abort') this.listeners.delete(listener);
    super.removeEventListener(type, listener, options);
  }

  abort() {
    if (this.aborted) return;
    this.aborted = true;
    this.dispatchEvent(new Event('abort'));
  }
}

const isAbortError = (error) => error?.name === 'AbortError';
const tick = () => new Promise(setImmediate);

function sessionAccount(openSession, token = mock.fn(async () => 'token')) {
  const signal = new BasicSignal();
  const account = new WalletAccountArkade(
    'ark-address',
    "m/86'/0'/0'/0/0",
    { dispose: async () => {} },
    { privateKey: new Uint8Array(32), publicKey: new Uint8Array(33) },
    {},
    Promise.resolve({})
  );
  account._controller = { signal, abort: () => signal.abort() };
  account._lnurl = { token };
  account._lnurlClient = { openSession };
  return { account, signal, token };
}

describe('basic AbortSignal compatibility', () => {
  it('executes a payment with a signal that has no throwIfAborted or reason', async () => {
    const signal = new BasicSignal();
    const execute = mock.fn(async () => ({ settled: async () => ({ txid: 'paid' }) }));
    const result = await send({
      router: { route: async () => ({ amount: 1000, fee: 0, send: execute }) },
      to: 'target',
      amount: 1000n,
      signal,
    });
    assert.deepEqual(result, { txid: 'paid', fee: 0n });
    assert.equal(execute.mock.callCount(), 1);
    assert.equal(signal.listeners.size, 0);
  });

  it('rejects a pre-aborted payment before quoting or spending', async () => {
    const signal = new BasicSignal();
    signal.abort();
    const route = mock.fn();
    await assert.rejects(
      send({ router: { route }, to: 'target', amount: 1000n, signal }),
      isAbortError
    );
    assert.equal(route.mock.callCount(), 0);
  });

  it('cancels a pending quote without executing its late result', async () => {
    const signal = new BasicSignal();
    let finish;
    const execute = mock.fn();
    const sending = send({
      router: {
        route: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
      to: 'target',
      amount: 1000n,
      signal,
    });
    const rejected = assert.rejects(sending, isAbortError);
    signal.abort();
    await rejected;
    finish({ amount: 1000, fee: 0, send: execute });
    await tick();
    assert.equal(execute.mock.callCount(), 0);
    assert.equal(signal.listeners.size, 0);
  });

  it('honors an already-aborted signal even if the awaited promise already settled', async () => {
    const signal = new BasicSignal();
    signal.abort();
    await assert.rejects(withAbort(Promise.resolve('late'), signal), isAbortError);
    await assert.rejects(
      withAbort(Promise.reject(new Error('late failure')), signal),
      isAbortError
    );
    assert.equal(signal.listeners.size, 0);
  });

  it('preserves the supplied abort reason', async () => {
    for (const reason of [new Error('caller stopped'), null, 0, 'stopped']) {
      const controller = new AbortController();
      controller.abort(reason);
      await assert.rejects(
        withAbort(Promise.resolve(), controller.signal),
        (error) => error === reason
      );
    }
  });
});

describe('portable LNURL session cancellation', () => {
  const handlers = { onInvoiceRequest() {} };

  it('rejects pre-aborted callers before deriving a token or opening a session', async () => {
    const caller = new BasicSignal();
    caller.abort();
    const open = mock.fn();
    const { account, signal, token } = sessionAccount(open);
    await assert.rejects(account.openLnurlSession(handlers, { signal: caller }), isAbortError);
    assert.equal(token.mock.callCount(), 0);
    assert.equal(open.mock.callCount(), 0);
    assert.equal(caller.listeners.size + signal.listeners.size, 0);
    await account.dispose();
  });

  for (const stage of ['token', 'open']) {
    it(`releases source listeners after ${stage} failure`, async () => {
      const failure = new Error(`${stage} failed`);
      const caller = new BasicSignal();
      const open = mock.fn(async () => {
        throw failure;
      });
      const token = mock.fn(async () => {
        if (stage === 'token') throw failure;
        return 'token';
      });
      const { account, signal } = sessionAccount(open, token);
      await assert.rejects(
        account.openLnurlSession(handlers, { signal: caller }),
        (error) => error === failure
      );
      assert.equal(caller.listeners.size + signal.listeners.size, 0);
      await account.dispose();
    });
  }

  for (const stop of ['caller', 'dispose']) {
    it(`cancels pending token derivation on ${stop} without opening transport later`, async () => {
      const caller = new BasicSignal();
      let finish;
      const open = mock.fn();
      const { account, signal } = sessionAccount(
        open,
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      );
      const opening = account.openLnurlSession(handlers, { signal: caller });
      const rejected = assert.rejects(opening, isAbortError);
      if (stop === 'caller') caller.abort();
      else await account.dispose();
      await rejected;
      assert.equal(caller.listeners.size + signal.listeners.size, 0);
      finish('late token');
      await tick();
      assert.equal(open.mock.callCount(), 0);
      await account.dispose();
    });
  }

  it('releases source listeners on close, including a throwing transport close', async () => {
    const caller = new BasicSignal();
    const close = mock.fn(() => {
      throw new Error('close failed');
    });
    const { account, signal } = sessionAccount(async () => ({ close }));
    const session = await account.openLnurlSession(handlers, { signal: caller });
    assert.equal(caller.listeners.size + signal.listeners.size, 2);
    assert.throws(() => session.close(), /close failed/);
    session.close();
    assert.equal(close.mock.callCount(), 1);
    assert.equal(caller.listeners.size + signal.listeners.size, 0);
    assert.equal(account._sessions.size, 0);
    await account.dispose();
  });

  for (const stop of ['caller', 'dispose']) {
    it(`closes a late-opening session once after ${stop} cancellation`, async () => {
      const caller = new BasicSignal();
      let entered;
      let finish;
      const started = new Promise((resolve) => {
        entered = resolve;
      });
      const { account, signal } = sessionAccount(() => {
        entered();
        return new Promise((resolve) => {
          finish = resolve;
        });
      });
      const opening = account.openLnurlSession(handlers, { signal: caller });
      const rejected = assert.rejects(opening, isAbortError);
      await started;
      if (stop === 'caller') caller.abort();
      else await account.dispose();
      await rejected;
      const close = mock.fn();
      finish({ close });
      await tick();
      assert.equal(close.mock.callCount(), 1);
      assert.equal(caller.listeners.size + signal.listeners.size, 0);
      assert.equal(account._sessions.size, 0);
      await account.dispose();
      assert.equal(close.mock.callCount(), 1);
    });
  }

  it('closes an opened session when the caller aborts', async () => {
    const caller = new BasicSignal();
    const close = mock.fn();
    const { account, signal } = sessionAccount(async () => ({ close }));
    const session = await account.openLnurlSession(handlers, { signal: caller });
    caller.abort();
    assert.equal(close.mock.callCount(), 1);
    assert.equal(caller.listeners.size + signal.listeners.size, 0);
    assert.equal(account._sessions.size, 0);
    session.close();
    await account.dispose();
    assert.equal(close.mock.callCount(), 1);
  });

  it('contains a transport close failure during account abort', async () => {
    const close = mock.fn(() => {
      throw new Error('close failed');
    });
    const { account, signal } = sessionAccount(async () => ({ close }));
    await account.openLnurlSession(handlers);
    await account.dispose();
    await tick();
    assert.equal(close.mock.callCount(), 1);
    assert.equal(signal.listeners.size, 0);
    assert.equal(account._sessions.size, 0);
  });

  it('closes a session when abort races its delivery to the caller', async () => {
    const caller = new BasicSignal();
    const close = mock.fn();
    const { account, signal } = sessionAccount(async () => ({ close }));
    const opening = account.openLnurlSession(handlers, { token: 'token', signal: caller });
    queueMicrotask(() => caller.abort());
    await assert.rejects(opening, isAbortError);
    assert.equal(close.mock.callCount(), 1);
    assert.equal(caller.listeners.size + signal.listeners.size, 0);
    assert.equal(account._sessions.size, 0);
    await account.dispose();
  });
});
