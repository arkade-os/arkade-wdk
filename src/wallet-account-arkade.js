import { BIP322 } from '@arkade-os/sdk';
import { UnsupportedOperationError } from '@tetherto/wdk-wallet';
import { createLnurlClient } from '@arkade-os/lnurl-client';
import { arkadeLnurl } from '@arkade-os/lnurl-client/arkade';
import { sodium_memzero } from 'sodium-universal';
import { createPaymentRouter, send } from './lib/send.js';
import { withAbort } from './lib/abort.js';
import { WalletAccountReadOnlyArkade } from './wallet-account-read-only-arkade.js';

export class WalletAccountArkade extends WalletAccountReadOnlyArkade {
  /**
   * @param {string} address
   * @param {string} path
   * @param {import('@arkade-os/sdk').Wallet} wallet
   * @param {import('@tetherto/wdk-wallet').KeyPair} keyPair
   * @param {import('@arkade-os/sdk').IndexerProvider} indexerProvider
   * @param {Promise<import('@arkade-os/sdk').OperatorInfo>} arkInfo
   * @param {{ solver?: import('@arkade-os/swap').SwapClient; lnurl?: import('@arkade-os/lnurl-client/arkade').ArkadeLnurlConfig; config?: import('@tetherto/wdk-wallet').WalletConfig & { paymentTimeoutMs?: number } }} [services]
   */
  constructor(address, path, wallet, keyPair, indexerProvider, arkInfo, services = {}) {
    super(address, wallet, indexerProvider, arkInfo, services.config);
    /** @readonly */
    this.path = path;
    /** @readonly */
    this.index = parseInt(path.split('/').pop() || '0', 10);
    /** @readonly @type {import('@tetherto/wdk-wallet').KeyPair} */
    this.keyPair = keyPair;
    /** @readonly */
    this.swapClient = services.solver;
    /** @private */
    this._lnurlClient = services.lnurl
      ? (services.lnurl.client ?? createLnurlClient({ baseUrl: services.lnurl.baseUrl }))
      : null;
    this._paymentRouter = createPaymentRouter(wallet, {
      solver: services.solver,
      client: this._lnurlClient ?? undefined,
    });
    /** @private */
    this._lnurl = services.lnurl
      ? arkadeLnurl({
          ...services.lnurl,
          wallet,
          client: this._lnurlClient ?? undefined,
          router: this._paymentRouter,
        })
      : null;
    if (this._lnurl) {
      // lnurl-client 0.9.4 otherwise replaces our injected payer transport on first use.
      this._lnurl.router = () => this._paymentRouter;
      this._lnurl.options = (target, amount, prefs) =>
        this._paymentRouter.options(
          typeof amount === 'number'
            ? { raw: target.trim(), amount }
            : { raw: target.trim(), unitAmount: amount },
          prefs
        );
    }
    /** @private */
    this._controller = new AbortController();
    /** @private @type {Set<import('@arkade-os/lnurl-client').LnurlSession>} */
    this._sessions = new Set();
    /** @private @type {Set<Promise<unknown>>} */
    this._payments = new Set();
    /** @private @type {Promise<void> | undefined} */
    this._disposePromise = undefined;
  }

  /** @protected */
  _disposeCheck() {
    if (this.disposed) throw new Error('WalletAccountArkade has been disposed');
  }

  /** @protected @returns {import('@arkade-os/sdk').Wallet} */
  get _signingWallet() {
    this._disposeCheck();
    return /** @type {import('@arkade-os/sdk').Wallet} */ (this._wallet);
  }

  /** @param {import('@tetherto/wdk-wallet').Transaction} tx */
  async sendTransaction(tx) {
    return this._send({
      to: tx.to,
      amount: BigInt(tx.value),
      maxFee: /** @type {number | bigint | undefined} */ (this._config.transactionMaxFee),
    });
  }

  /** @param {import('@tetherto/wdk-wallet').Transaction} tx @returns {Promise<{ fee: bigint }>} */
  async quoteSendTransaction(tx) {
    this._disposeCheck();
    return super.quoteSendTransaction(tx);
  }

  /** @param {import('@tetherto/wdk-wallet').TransferOptions} options */
  async transfer(options) {
    return this._send({
      to: options.recipient,
      amount: 0n,
      assets: [{ assetId: options.token, amount: BigInt(options.amount) }],
      maxFee: /** @type {number | bigint | undefined} */ (this._config.transferMaxFee),
    });
  }

  /** @private @param {Omit<import('./lib/send.js').SendOptions, 'router' | 'signal' | 'trackCompletion'>} options */
  async _send(options) {
    this._disposeCheck();
    const payment = send({
      ...options,
      router: this._paymentRouter,
      paymentTimeoutMs: /** @type {number | undefined} */ (this._config.paymentTimeoutMs),
      signal: this._controller.signal,
      trackCompletion: (completion) => {
        this._payments.add(completion);
        const forget = () => this._payments.delete(completion);
        void completion.then(forget, forget);
      },
    });
    this._payments.add(payment);
    try {
      const result = await payment;
      return { hash: result.txid, fee: result.fee };
    } finally {
      this._payments.delete(payment);
    }
  }

  /** @param {string} message */
  async sign(message) {
    return BIP322.sign(message, this._signingWallet.identity);
  }

  /** @param {(coins: import('@arkade-os/sdk').IncomingFunds) => void} callback */
  async subscribeToIncomingFunds(callback) {
    return this._signingWallet.notifyIncomingFunds(callback);
  }

  async toReadOnlyAccount() {
    return new WalletAccountReadOnlyArkade(
      await this.getAddress(),
      await this._signingWallet.toReadonly(),
      this._indexerProvider,
      this._arkInfo,
      this._config
    );
  }

  /** @returns {import('@arkade-os/lnurl-client/arkade').ArkadeLnurl} */
  getLnurl() {
    this._disposeCheck();
    if (!this._lnurl) throw new Error('LNURL receiving requires lnurl.baseUrl in wallet config.');
    return this._lnurl;
  }

  /** @returns {import('@arkade-os/lnurl-client').LnurlClient} */
  getLnurlClient() {
    this._disposeCheck();
    if (!this._lnurlClient)
      throw new Error('LNURL receiving requires lnurl.baseUrl in wallet config.');
    return this._lnurlClient;
  }

  /** @param {import('@arkade-os/lnurl-client').SessionHandlers} handlers
   * @param {import('@arkade-os/lnurl-client').OpenSessionOptions} [options] */
  async openLnurlSession(handlers, options = {}) {
    this._disposeCheck();
    const signal = AbortSignal.any([
      this._controller.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    const token = options.token ?? (await this.getLnurl().token());
    signal.throwIfAborted();
    const opening = this.getLnurlClient().openSession({ ...options, token, signal }, handlers);
    void opening.then(
      (session) => {
        if (signal.aborted) session.close();
      },
      () => {}
    );
    const session = await withAbort(opening, signal);
    signal.throwIfAborted();
    const close = session.close.bind(session);
    session.close = () => {
      this._sessions.delete(session);
      close();
    };
    this._sessions.add(session);
    return session;
  }

  get disposed() {
    return this._disposePromise !== undefined;
  }

  /** @param {import('@tetherto/wdk-wallet').Transaction} _tx @returns {Promise<string>} */
  async signTransaction(_tx) {
    throw new UnsupportedOperationError(
      'Arkade transactions require sendTransaction for operator cosigning.'
    );
  }

  dispose() {
    if (!this._disposePromise) {
      this._disposePromise = Promise.resolve().then(async () => {
        try {
          for (const session of this._sessions) session.close();
          this._sessions.clear();
          // A caller timeout does not cancel its native payment.
          while (this._payments.size) await Promise.allSettled(this._payments);
          await this.swapClient?.[Symbol.asyncDispose]();
        } finally {
          try {
            await /** @type {import('@arkade-os/sdk').Wallet} */ (this._wallet).dispose();
          } finally {
            if (this.keyPair.privateKey) sodium_memzero(this.keyPair.privateKey);
          }
        }
      });
      this._controller.abort(new Error('WalletAccountArkade has been disposed'));
    }
    return this._disposePromise;
  }
}
