import WalletManager from '@tetherto/wdk-wallet';
import {
  RestOperatorProvider,
  RestIndexerProvider,
  SingleKey,
  Wallet,
  InMemoryWalletRepository,
  InMemoryContractRepository,
  maybeArkError,
} from '@arkade-os/sdk';
import { HDKey } from '@scure/bip32';
import { createSwapClient } from '@arkade-os/swap';
import { sodium_memzero } from 'sodium-universal';
import { WalletAccountArkade } from './wallet-account-arkade.js';

/** @typedef {import('./types.js').ArkadeWalletConfig} ArkadeWalletConfig */

class WalletManagerArkade extends WalletManager {
  /** @param {string | Uint8Array} seed @param {ArkadeWalletConfig} [config] */
  constructor(seed, config = {}) {
    super(seed, config);
    const url =
      config.arkServerUrl ??
      (config.service && 'operatorUrl' in config.service ? config.service.operatorUrl : undefined);
    /** @private */
    this._arkProvider =
      config.operatorProvider ?? config.arkProvider ?? new RestOperatorProvider(url);
    /** @private */
    this._info = this._arkProvider
      .getInfo()
      .catch((error) => {
        const arkError = maybeArkError(error);
        if (arkError?.name === 'BUILD_VERSION_TOO_OLD') {
          const minimum = arkError.metadata?.min_version ?? arkError.metadata?.minVersion;
          throw new Error(
            `Arkade operator requires a newer client build${minimum ? ` (minimum ${minimum})` : ''}. Update @arkade-os/sdk.`,
            { cause: error }
          );
        }
        return this._arkProvider.getInfo();
      })
      .then((info) => {
        if (
          config.service &&
          'network' in config.service &&
          info.network !== config.service.network
        ) {
          throw new Error(`Arkade service network mismatch: ${info.network}`);
        }
        return info;
      });
    void this._info.catch(() => {});
    /** @private */
    this._url = url;
    /** @private @type {Map<string, Promise<WalletAccountArkade>>} */
    this._accountPromises = new Map();
    /** @private @type {Promise<void> | undefined} */
    this._disposePromise = undefined;
  }

  /** @private */
  _disposeCheck() {
    if (this.disposed || this._disposePromise)
      throw new Error('WalletManagerArkade has been disposed');
  }

  /** @param {number | string} [index] @param {{ signerName?: string }} [options] */
  async getAccount(index = 0, options = {}) {
    this._disposeCheck();
    if (typeof index !== 'number' || options.signerName) {
      throw new Error(
        'Arkade supports seed-derived accounts by numeric index; named signers are not supported.'
      );
    }
    if (!Number.isSafeInteger(index) || index < 0 || index >= 2 ** 31) {
      throw new Error('Invalid account index.');
    }
    const info = await this._info;
    const coin = ['bitcoin', 'mainnet'].includes(String(info.network)) ? 0 : 1;
    return this.getAccountByPath(`m/86'/${coin}/0'/0/${index}`);
  }

  /** @param {string} path @param {{ signerName?: string }} [options] */
  async getAccountByPath(path, options = {}) {
    this._disposeCheck();
    if (options.signerName) throw new Error('Arkade supports seed-derived accounts only.');
    let pending = this._accountPromises.get(path);
    if (!pending) {
      pending = this._createAccount(path);
      this._accountPromises.set(path, pending);
      void pending.catch(() => {
        this._accountPromises.delete(path);
      });
    }
    const account = await pending;
    this._disposeCheck();
    return account;
  }

  /** @private @param {string} path */
  async _createAccount(path) {
    const cfg = /** @type {ArkadeWalletConfig} */ (this._config);
    const info = await this._info;
    if (!this.seed) throw new Error('Arkade requires a seed-backed wallet manager.');
    const master = HDKey.fromMasterSeed(this.seed);
    let key;
    try {
      key = master.derive(path);
    } finally {
      master.wipePrivateData();
    }
    if (!key.privateKey || !key.publicKey) throw new Error(`Failed to derive key at ${path}`);

    /** @type {Wallet | undefined} */
    let wallet;
    /** @type {import('@arkade-os/swap').SwapClient | undefined} */
    let solver;
    try {
      wallet = await Wallet.create({
        ...cfg,
        service: undefined,
        operatorProvider: this._arkProvider,
        indexerProvider:
          cfg.indexerProvider ?? (this._url ? new RestIndexerProvider(this._url) : undefined),
        identity: SingleKey.fromPrivateKey(key.privateKey),
        // Bare has no IndexedDB; persistent repositories can be injected.
        storage: cfg.storage ?? {
          walletRepository: new InMemoryWalletRepository(),
          contractRepository: new InMemoryContractRepository(),
        },
      });
      if (cfg.solver) {
        const solverConfig = cfg.solver(path);
        if (!solverConfig.repository)
          throw new Error('Solver swaps require a persistent repository.');
        solver = createSwapClient({ ...solverConfig, wallet });
        await solver.ready;
      }
      const lnurl =
        cfg.lnurl ??
        (info.network === 'bitcoin'
          ? { baseUrl: 'https://lnurl.arkade.sh', domain: 'arkade.money' }
          : info.network === 'mutinynet'
            ? { baseUrl: 'https://lnurl.mutinynet.arkade.sh', domain: 'lnurl.mutinynet.arkade.sh' }
            : undefined);
      const account = new WalletAccountArkade(
        await wallet.getAddress(),
        path,
        wallet,
        { privateKey: key.privateKey, publicKey: key.publicKey },
        wallet.indexerProvider,
        this._info,
        {
          solver,
          lnurl,
          config: {
            transactionMaxFee: cfg.transactionMaxFee,
            transferMaxFee: cfg.transferMaxFee,
          },
        }
      );
      this._accounts[path] = account;
      return account;
    } catch (error) {
      try {
        await solver?.[Symbol.asyncDispose]();
      } finally {
        try {
          await wallet?.dispose();
        } finally {
          key.wipePrivateData();
        }
      }
      throw error;
    }
  }

  /** @returns {Promise<import('@tetherto/wdk-wallet').FeeRates>} */
  async getFeeRates() {
    this._disposeCheck();
    const feeRate = Number((await this._info).fees.txFeeRate);
    if (!Number.isFinite(feeRate) || feeRate < 0) throw new Error('Invalid Arkade fee rate');
    const rate = BigInt(Math.ceil(feeRate));
    return { normal: rate, fast: rate };
  }

  dispose() {
    if (!this._disposePromise) {
      this._disposePromise = (async () => {
        try {
          const created = await Promise.allSettled(this._accountPromises.values());
          const disposed = await Promise.allSettled(
            created.flatMap((result) =>
              result.status === 'fulfilled' ? [result.value.dispose()] : []
            )
          );
          const errors = disposed.flatMap((result) =>
            result.status === 'rejected' ? [result.reason] : []
          );
          if (errors.length) throw new AggregateError(errors, 'Arkade account disposal failed');
        } finally {
          super.dispose();
          if (this.seed) sodium_memzero(this.seed);
        }
      })();
    }
    return this._disposePromise;
  }
}

export default WalletManagerArkade;
