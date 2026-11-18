import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ArkAddress, SingleKey } from '@arkade-os/sdk';
import { WalletAccountArkade } from '../wallet-account-arkade.js';
import { WalletAccountReadOnlyArkade } from '../wallet-account-read-only-arkade.js';

afterEach(() => mock.restoreAll());

async function account(seed) {
  const identity = SingleKey.fromPrivateKey(new Uint8Array(32).fill(seed));
  const readonlyIdentity = await identity.toReadonly();
  const address = new ArkAddress(
    new Uint8Array(32).fill(9),
    await identity.xOnlyPublicKey(),
    'tark'
  ).encode();
  const wallet = {
    identity,
    getAddress: async () => address,
    dispose: async () => {},
    toReadonly: async () => ({ identity: readonlyIdentity }),
  };
  return new WalletAccountArkade(
    address,
    "m/86'/1/0'/0/0",
    wallet,
    { privateKey: new Uint8Array(32).fill(seed), publicKey: await identity.compressedPublicKey() },
    {},
    Promise.resolve({})
  );
}

describe('BIP322 account signatures', () => {
  it('verifies its own SDK signature through the full and read-only accounts', async () => {
    const signer = await account(3);
    const fetch = mock.method(globalThis, 'fetch', async () => {
      throw new Error('Verification must stay local');
    });
    try {
      const signature = await signer.sign('WDK regtest end-to-end');
      assert.equal(await signer.verify('WDK regtest end-to-end', signature), true);
      const readonly = await signer.toReadOnlyAccount();
      assert.ok(readonly instanceof WalletAccountReadOnlyArkade);
      assert.equal(await readonly.verify('WDK regtest end-to-end', signature), true);
      assert.equal(readonly._wallet.identity.sign, undefined);
      assert.equal(readonly._wallet.identity.key, undefined);
      assert.equal(fetch.mock.callCount(), 0);
    } finally {
      await signer.dispose();
    }
  });

  it('rejects a changed message, another identity, and malformed signatures', async () => {
    const signer = await account(3);
    const stranger = await account(4);
    try {
      const signature = await signer.sign('original');
      const readonly = await signer.toReadOnlyAccount();
      assert.equal(await readonly.verify('changed', signature), false);
      assert.equal(await stranger.verify('original', signature), false);
      assert.equal(await readonly.verify('original', 'invalid signature'), false);
    } finally {
      await signer.dispose();
      await stranger.dispose();
    }
  });
});
