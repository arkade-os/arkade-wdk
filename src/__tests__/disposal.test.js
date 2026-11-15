import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { WalletAccountArkade } from '../wallet-account-arkade.js';
import { WalletAccountReadOnlyArkade } from '../wallet-account-read-only-arkade.js';

const reads = [
  ['getAddress', []],
  ['getBoardingAddress', []],
  ['getBalance', []],
  ['getTokenBalance', ['asset']],
  ['getTransactionHistory', []],
  ['getTransaction', ['txid']],
  ['getTransactionReceipt', ['txid']],
  ['verify', ['message', 'signature']],
  ['quoteSendTransaction', [{ to: 'ark-address', value: 1000n }]],
  ['quoteTransfer', [{ token: 'asset', recipient: 'ark-address', amount: 100n }]],
];

for (const Account of [WalletAccountReadOnlyArkade, WalletAccountArkade]) {
  describe(`${Account.name} disposal`, () => {
    it('rejects later reads and quotes without reopening SDK resources', async () => {
      const accessed = mock.fn(() => {
        throw new Error('Disposed SDK must not be accessed');
      });
      const wallet = new Proxy(
        { dispose: mock.fn(async () => {}), identity: {} },
        {
          get(target, property) {
            if (property in target) return target[property];
            return accessed;
          },
        }
      );
      const indexer = { getVirtualTxs: accessed };
      const account =
        Account === WalletAccountArkade
          ? new Account(
              'ark-address',
              "m/86'/0'/0'/0/0",
              wallet,
              { publicKey: new Uint8Array(33), privateKey: new Uint8Array(32).fill(1) },
              indexer,
              Promise.resolve({})
            )
          : new Account('ark-address', wallet, indexer, Promise.resolve({}));
      account._paymentRouter = { route: accessed };
      const disposed = account.dispose();
      for (const [method, args] of reads) {
        await assert.rejects(account[method](...args), /has been disposed/, method);
      }
      await disposed;
      await account.dispose();
      assert.equal(accessed.mock.callCount(), 0);
      assert.equal(wallet.dispose.mock.callCount(), 1);
    });
  });
}
