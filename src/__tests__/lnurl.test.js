import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ArkAddress, SingleKey } from '@arkade-os/sdk';
import { createLnurlClient } from '@arkade-os/lnurl-client';
import { bootstrapReceiver } from '@arkade-os/lnurl-client/arkade';
import { hex } from '@scure/base';
import { WalletAccountArkade } from '../wallet-account-arkade.js';

const baseUrl = 'https://lnurl.example.com';
const domain = 'wallet.example.com';
const arkadeAddress = new ArkAddress(
  new Uint8Array(32).fill(1),
  new Uint8Array(32).fill(2),
  'tark'
).encode();
const boardingAddress = 'tb1pboarding';
const registered = { handle: 'alice', lightningAddress: `alice@${domain}`, domain };
const capabilities = {
  domain,
  allocationModes: ['session', 'username'],
  requireApiKey: false,
  usernameRules: { minLen: 3, maxLen: 32, pattern: '^[a-z]+$' },
};

function accountWithServer(respond) {
  const privateKey = new Uint8Array(32).fill(3);
  const identity = SingleKey.fromPrivateKey(privateKey);
  const fetchImpl = mock.fn(async (url, init = {}) => respond(url, init));
  const client = createLnurlClient({ baseUrl, fetchImpl });
  const wallet = {
    identity,
    getAddress: async () => arkadeAddress,
    getBoardingAddress: async () => boardingAddress,
    dispose: mock.fn(async () => {}),
  };
  const account = new WalletAccountArkade(
    arkadeAddress,
    "m/86'/1/0'/0/0",
    wallet,
    { publicKey: new Uint8Array(33), privateKey },
    {},
    Promise.resolve({}),
    { lnurl: { baseUrl, domain, client } }
  );
  return { account, identity, fetchImpl, client, wallet };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('LNURL receiver', () => {
  it('keeps the configured payer transport when the facade router is used', async () => {
    const { account, fetchImpl } = accountWithServer(() =>
      json({
        tag: 'payRequest',
        callback: `${baseUrl}/callback`,
        minSendable: 1000,
        maxSendable: 10000000,
        metadata: '[]',
        paymentOptions: [{ type: 'arkade' }],
      })
    );
    const facade = account.getLnurl();
    assert.equal(facade.router(), account._paymentRouter);
    const options = await facade.options('alice@wallet.example.com', 1000);
    assert.deepEqual(
      options.map((option) => option.railId),
      ['lnurl-arkade']
    );
    assert.equal(fetchImpl.mock.callCount(), 1);
    await account.dispose();
  });
  it('requires receive configuration on a directly constructed account', () => {
    const account = new WalletAccountArkade(
      arkadeAddress,
      "m/86'/1/0'/0/0",
      {},
      { publicKey: new Uint8Array(33), privateKey: new Uint8Array(32) },
      {},
      Promise.resolve({})
    );

    assert.throws(() => account.getLnurl(), /LNURL.*config/i);
  });

  it('claims a name and binds the wallet destinations and public key through lnurl-client', async () => {
    const { account, identity, fetchImpl } = accountWithServer((url) =>
      json(url.endsWith('/arkade') ? {} : registered)
    );
    const facade = account.getLnurl();
    const receiver = await facade.claim({ username: 'alice' });

    assert.equal(account.getLnurl(), facade);
    assert.equal(receiver.lightningAddress, `alice@${domain}`);
    assert.equal(fetchImpl.mock.callCount(), 2);
    const [registrationUrl, registration] = fetchImpl.mock.calls[0].arguments;
    const [bindingUrl, binding] = fetchImpl.mock.calls[1].arguments;
    const request = JSON.parse(registration.body);
    assert.equal(registrationUrl, `${baseUrl}/lnurl/address`);
    assert.equal(registration.method, 'POST');
    assert.equal(request.username, 'alice');
    assert.equal(request.domain, domain);
    assert.equal(typeof request.token, 'string');
    assert.equal(bindingUrl, `${baseUrl}/lnurl/address/alice/arkade`);
    assert.equal(binding.headers.Authorization, `Bearer ${request.token}`);
    assert.deepEqual(JSON.parse(binding.body), {
      arkadeAddress,
      boardingAddress,
      domain,
      claimPublicKey: hex.encode(await identity.compressedPublicKey()),
    });
  });

  it('claims and binds the same receiver in Bare without SubtleCrypto', async (t) => {
    const respond = (url) => json(url.endsWith('/arkade') ? {} : registered);
    const baseline = accountWithServer(respond);
    const token = await baseline.account.getLnurl().token();
    await baseline.account.dispose();

    const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    t.mock.getter(globalThis, 'crypto', () => ({ getRandomValues }));
    const { account, identity, fetchImpl } = accountWithServer(respond);
    t.after(() => account.dispose());
    const receiver = await account.getLnurl().claim({ username: 'alice' });

    assert.equal(receiver.lightningAddress, registered.lightningAddress);
    const [, registration] = fetchImpl.mock.calls[0].arguments;
    const [, binding] = fetchImpl.mock.calls[1].arguments;
    assert.equal(JSON.parse(registration.body).token, token);
    assert.equal(binding.headers.Authorization, `Bearer ${token}`);
    assert.equal(
      JSON.parse(binding.body).claimPublicKey,
      hex.encode(await identity.compressedPublicKey())
    );
  });

  it('discovers an existing owned receiver without registration or identity writes', async () => {
    const { account, fetchImpl } = accountWithServer(() =>
      json([
        { ...registered, handle: 'revoked', status: 'revoked' },
        { ...registered, handle: 'foreign', domain: 'elsewhere.example', status: 'active' },
        { ...registered, status: 'active' },
      ])
    );
    const receiver = await account.getLnurl().owned();

    assert.equal(receiver.handle, 'alice');
    assert.equal(receiver.lightningAddress, `alice@${domain}`);
    assert.equal(fetchImpl.mock.callCount(), 1);
    const [url, init] = fetchImpl.mock.calls[0].arguments;
    assert.equal(url, `${baseUrl}/lnurl/address`);
    assert.equal(init.method, undefined);
    assert.match(init.headers.Authorization, /^Bearer .+/);
  });

  it('refreshes stale receiver destinations before returning the owned address', async () => {
    const { account, fetchImpl } = accountWithServer((url) =>
      json(
        url.endsWith('/arkade') ? {} : [{ ...registered, status: 'active', arkadeAddress: 'stale' }]
      )
    );
    const receiver = await account.getLnurl().owned({ refresh: true });

    assert.equal(receiver.handle, 'alice');
    assert.equal(fetchImpl.mock.callCount(), 2);
    const [url, init] = fetchImpl.mock.calls[1].arguments;
    assert.equal(url, `${baseUrl}/lnurl/address/alice/arkade`);
    assert.equal(JSON.parse(init.body).arkadeAddress, arkadeAddress);
    assert.equal(JSON.parse(init.body).boardingAddress, boardingAddress);
  });

  it('fails the claim if the server refuses the receive binding', async () => {
    const { account } = accountWithServer((url) =>
      url.endsWith('/arkade') ? json({ error: 'binding refused' }, 503) : json(registered)
    );

    await assert.rejects(account.getLnurl().claim({ username: 'alice' }), /binding refused|503/);
  });

  it('leaves an unallocated identity in onboarding without creating an address', async () => {
    const { account, fetchImpl } = accountWithServer((url) =>
      json(url.includes('/lnurl/domain') ? capabilities : [])
    );
    const result = await bootstrapReceiver(account.getLnurl());

    assert.equal(result.kind, 'onboarding');
    assert.equal(fetchImpl.mock.callCount(), 2);
    assert.ok(fetchImpl.mock.calls.every(({ arguments: [, init] }) => init?.method !== 'POST'));
  });

  it('allocates and binds a session receiver only when explicitly requested', async () => {
    const { account, fetchImpl } = accountWithServer((url, init) => {
      if (url.includes('/lnurl/domain')) return json(capabilities);
      if (url.endsWith('/arkade')) return json({});
      if (init.method === 'POST') {
        return json({
          handle: 'session-handle',
          domain,
          sessionLnurl: 'server-session',
          nameless: true,
        });
      }
      return json([]);
    });
    const result = await bootstrapReceiver(account.getLnurl(), { autoClaimNameless: true });

    assert.equal(result.kind, 'ready');
    assert.equal(result.claimed, true);
    assert.equal(result.receiver.lightningAddress, undefined);
    assert.match(result.receiver.lnurl, /^LNURL1/);
    const registration = fetchImpl.mock.calls.find(
      ({ arguments: [url, init] }) => url === `${baseUrl}/lnurl/address` && init.method === 'POST'
    );
    assert.equal(JSON.parse(registration.arguments[1].body).nameless, true);
    assert.equal(fetchImpl.mock.callCount(), 4);
  });
});

describe('LNURL interactive sessions', () => {
  const frame = (event, data) =>
    new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  it(
    'uses the configured client and stable token for invoice requests and settlement',
    { timeout: 3000 },
    async () => {
      let stream;
      const { account, client, fetchImpl, wallet } = accountWithServer((url, init) => {
        if (url.endsWith('/lnurl/session')) {
          const { token } = JSON.parse(init.body);
          return new Response(
            new ReadableStream({
              start(controller) {
                stream = controller;
                controller.enqueue(
                  frame('session_created', {
                    sessionId: 'session-1',
                    lnurl: 'LNURL1SESSION',
                    token,
                  })
                );
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } }
          );
        }
        return json({});
      });
      let answered;
      const invoiceAnswered = new Promise((resolve) => {
        answered = resolve;
      });
      const errors = [];
      const session = await account.openLnurlSession(
        {
          async onInvoiceRequest(request, respond) {
            assert.deepEqual(request, { amountMsat: 1000000, comment: 'coffee' });
            await respond.answerInvoice('lnbc1invoice');
            answered();
          },
          onError(error) {
            errors.push(error);
          },
        },
        { reconnect: false }
      );

      try {
        assert.equal(account.getLnurlClient(), client);
        assert.equal(session.token, await account.getLnurl().token());
        assert.equal(session.closed, false);
        stream.enqueue(frame('invoice_request', { amountMsat: 1000000, comment: 'coffee' }));
        await invoiceAnswered;
        await session.reportSettled('preimage');
        const invoice = fetchImpl.mock.calls.find(({ arguments: [url] }) =>
          url.endsWith('/invoice')
        );
        const settled = fetchImpl.mock.calls.find(({ arguments: [url] }) =>
          url.endsWith('/settled')
        );
        assert.deepEqual(JSON.parse(invoice.arguments[1].body), { pr: 'lnbc1invoice' });
        assert.deepEqual(JSON.parse(settled.arguments[1].body), { preimage: 'preimage' });
        assert.equal(invoice.arguments[1].headers.Authorization, `Bearer ${session.token}`);
        assert.deepEqual(errors, []);
      } finally {
        await account.dispose();
      }

      assert.equal(session.closed, true);
      assert.equal(account._sessions.size, 0);
      assert.equal(wallet.dispose.mock.callCount(), 1);
      await assert.rejects(account.openLnurlSession({ onInvoiceRequest() {} }), /disposed/);
    }
  );

  it(
    'aborts a session opening before its first frame when the account is disposed',
    { timeout: 3000 },
    async () => {
      let requested;
      const requestStarted = new Promise((resolve) => {
        requested = resolve;
      });
      let signal;
      const { account } = accountWithServer((_url, init) => {
        signal = init.signal;
        requested();
        return new Response(new ReadableStream(), {
          headers: { 'content-type': 'text/event-stream' },
        });
      });
      const opening = account.openLnurlSession({ onInvoiceRequest() {} }, { reconnect: false });
      const rejected = assert.rejects(opening, /abort|closed|disposed/i);
      await requestStarted;
      await account.dispose();
      await rejected;

      assert.equal(signal.aborted, true);
    }
  );
});
