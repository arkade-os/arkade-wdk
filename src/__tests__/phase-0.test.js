import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as wdkExports from '../index.js';
import WalletManagerArkade from '../wallet-manager-arkade.js';

const validSeedPhrase =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const stubArkProvider = {
  getInfo: async () => ({ network: 'regtest', fees: { txFeeRate: '3' } }),
};
describe('0.7 — root index re-exports', () => {
  it('re-exports the three account/manager classes', () => {
    assert.equal(typeof wdkExports.default, 'function');
    assert.equal(typeof wdkExports.WalletAccountArkade, 'function');
    assert.equal(typeof wdkExports.WalletAccountReadOnlyArkade, 'function');
  });
});

describe('0.3 — getFeeRates from arkInfo', () => {
  it('returns the txFeeRate as a bigint, with normal === fast (no tiers on Arkade)', async () => {
    const provider = {
      getInfo: () => Promise.resolve({ network: 'regtest', fees: { txFeeRate: '7' } }),
    };
    const manager = new WalletManagerArkade(validSeedPhrase, { arkProvider: provider });

    const rates = await manager.getFeeRates();

    assert.equal(rates.normal, 7n);
    assert.equal(rates.fast, 7n);
  });

  it('rounds fractional fee rates upward', async () => {
    const provider = {
      getInfo: () => Promise.resolve({ network: 'regtest', fees: { txFeeRate: '2.3' } }),
    };
    const manager = new WalletManagerArkade(validSeedPhrase, { arkProvider: provider });

    const rates = await manager.getFeeRates();

    assert.equal(rates.normal, 3n);
    assert.equal(rates.fast, 3n);
  });

  it('throws after dispose', async () => {
    const manager = new WalletManagerArkade(validSeedPhrase, { arkProvider: stubArkProvider });
    await manager.dispose();
    await assert.rejects(manager.getFeeRates(), /disposed/);
  });
});
