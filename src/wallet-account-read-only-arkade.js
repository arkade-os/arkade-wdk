import { WalletAccountReadOnly, NoSuchElementError } from '@tetherto/wdk-wallet';
import { BIP322 } from '@arkade-os/sdk';
import { createReadOnlyPaymentRouter, quoteSend } from './lib/send.js';

/**
 * Read-only Bitcoin wallet account with Arkade support.
 * Extends the WDK base class to inherit standard address handling
 * and provide query-only access to balances, history, and fee quotes.
 */
export class WalletAccountReadOnlyArkade extends WalletAccountReadOnly {
  /**
   * @param {string} address
   * @param {import('@arkade-os/sdk').IReadonlyWallet} wallet
   * @param {import('@arkade-os/sdk').IndexerProvider} indexerProvider
   * @param {Promise<import('@arkade-os/sdk').OperatorInfo>} arkInfo
   * @param {import('@tetherto/wdk-wallet').WalletConfig} [config]
   */
  constructor(address, wallet, indexerProvider, arkInfo, config = {}) {
    super(address, config);
    /** @protected */
    this._wallet = wallet;
    /** @protected */
    this._indexerProvider = indexerProvider;
    /** @protected */
    this._arkInfo = arkInfo;
    /** @protected */
    this._paymentRouter = createReadOnlyPaymentRouter(wallet, arkInfo);
  }

  /**
   * Get the on-chain Bitcoin boarding address for initial deposits
   * @returns {Promise<string>}
   */
  async getBoardingAddress() {
    return await this._wallet.getBoardingAddress();
  }

  /** @returns {Promise<bigint>} */
  async getBalance() {
    const balance = await this._wallet.getBalance();
    return BigInt(balance.total);
  }

  /**
   * @param {string} message
   * @param {string} signature
   * @returns {Promise<boolean>}
   */
  async verify(message, signature) {
    return BIP322.verify(message, signature, await this.getAddress());
  }

  /**
   * @param {string} hash
   * @returns {Promise<unknown>}
   */
  async getTransactionReceipt(hash) {
    const res = await this._indexerProvider.getVirtualTxs([hash]);
    return res.txs.length > 0 ? res.txs[0] : null;
  }

  /** @returns {Promise<import('@arkade-os/sdk').ArkTransaction[]>} */
  async getTransactionHistory() {
    return await this._wallet.getTransactionHistory();
  }

  /** @param {string} hash @returns {Promise<import('@tetherto/wdk-wallet').TransactionReceipt>} */
  async getTransaction(hash) {
    const history = await this._wallet.getTransactionHistory();
    const transaction = history.find((tx) => Object.values(tx.key).includes(hash));
    if (!transaction) throw new NoSuchElementError(`Transaction not found: ${hash}`);
    return { hash, finality: transaction.settled ? 'confirmed' : 'pending' };
  }

  /**
   * @param {string} tokenAddress
   * @returns {Promise<bigint>}
   */
  async getTokenBalance(tokenAddress) {
    const balance = await this._wallet.getBalance();
    const asset = balance.assets.find(
      (/** @type {{ assetId: string; amount: bigint }} */ a) => a.assetId === tokenAddress
    );
    return asset ? BigInt(asset.amount) : 0n;
  }

  /**
   * @param {import('@tetherto/wdk-wallet').Transaction} tx
   * @returns {Promise<Omit<import('@tetherto/wdk-wallet').TransactionResult, 'hash'>>}
   */
  async quoteSendTransaction(tx) {
    const estimate = await quoteSend({
      to: tx.to,
      amount: BigInt(tx.value),
      router: this._paymentRouter,
    });
    return { fee: estimate.fee };
  }

  /**
   * @param {{ token: string; recipient: string; amount: number | bigint }} options
   * @returns {Promise<Omit<import('@tetherto/wdk-wallet').TransferResult, 'hash'>>}
   */
  async quoteTransfer(options) {
    const feeEstimate = await quoteSend({
      to: options.recipient,
      amount: 0n,
      assets: [{ assetId: options.token, amount: BigInt(options.amount) }],
      router: this._paymentRouter,
    });
    return { fee: feeEstimate.fee };
  }
}
