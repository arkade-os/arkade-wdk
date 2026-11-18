import {
  BIP21,
  PaymentRouter,
  arkRail,
  arkAssetRail,
  onchainRail,
  createDefaultPaymentRouter,
  arkTarget,
  isLnurl,
  walletFeeSource,
  selectVirtualCoins,
  resolveSendAmount,
  Estimator,
  toOffchainInputFeeParams,
  DustChangeError,
} from '@arkade-os/sdk';
import { lightningRail } from '@arkade-os/swap';
import { createLnurlClient } from '@arkade-os/lnurl-client';
import { MaximumFeeExceededError } from '@tetherto/wdk-wallet';
import { throwIfAborted, withAbort } from './abort.js';
import {
  arkadePaymentRouter,
  DEFAULT_RAIL_PRIORITY,
  lnurlRails,
} from '@arkade-os/lnurl-client/arkade';

/** @param {import('@arkade-os/sdk').IWallet} wallet */
export function withZeroChangeFee(wallet) {
  return new Proxy(wallet, {
    get(target, property) {
      if (property === 'send') {
        /** @param {Parameters<import('@arkade-os/sdk').IWallet['send']>} args */
        return (...args) => {
          const first = args[0];
          const params =
            args.length === 1 && 'recipients' in first
              ? first
              : {
                  recipients:
                    /** @type {[import('@arkade-os/sdk').Recipient, ...import('@arkade-os/sdk').Recipient[]]} */ (
                      args
                    ),
                };
          return target.send({ ...params, maxChangeFee: 0 });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * @param {import('@arkade-os/sdk').IWallet} wallet
 * @param {{ solver?: import('@arkade-os/swap').SwapRailClient | null; client?: import('@arkade-os/lnurl-client').LnurlClient }} [options]
 * @returns {import('@arkade-os/lnurl-client/arkade').LnurlPaymentRouter}
 */
export function createPaymentRouter(wallet, { solver = null, client } = {}) {
  const guarded = withZeroChangeFee(wallet);
  const concrete = /** @type {import('@arkade-os/sdk').Wallet} */ (guarded);
  const router = createDefaultPaymentRouter(concrete).use(
    cappedOnchainRail(walletFeeSource(concrete))
  );
  const rail = solver ? lightningRail(solver) : undefined;
  return arkadePaymentRouter({ wallet: guarded, router, lightning: rail, client });
}

/**
 * @param {import('@arkade-os/sdk').IReadonlyWallet} wallet
 * @param {Promise<import('@arkade-os/sdk').OperatorInfo>} arkInfo
 * @returns {import('@arkade-os/lnurl-client/arkade').LnurlPaymentRouter}
 */
export function createReadOnlyPaymentRouter(wallet, arkInfo) {
  // Core quotes only read the wallet; this bridge supplies no signing capability.
  const router = new PaymentRouter({
    wallet: /** @type {import('@arkade-os/sdk').IWallet} */ (wallet),
    prefs: { priority: ['ark', 'ark-asset', 'onchain', 'lnurl-arkade'] },
  })
    .use(arkRail())
    .use(arkAssetRail())
    .use(cappedOnchainRail(async () => (await arkInfo).fees));
  for (const rail of lnurlRails({ client: createLnurlClient(), arkade: arkRail() })) {
    router.use(rail);
  }
  return router;
}

/** @param {number | bigint} amount */
function safeOnchainSats(amount) {
  const sats = Number(amount);
  if (!Number.isSafeInteger(sats)) {
    throw new RangeError('Onchain payment exceeds the safe integer satoshi range');
  }
  return sats;
}

/** @param {() => Promise<import('@arkade-os/sdk').FeeInfo>} feeInfo
 * @returns {import('@arkade-os/sdk').PaymentRail} */
function cappedOnchainRail(feeInfo) {
  const rail = onchainRail({ feeInfo });
  return {
    ...rail,
    async quote(req, ctx) {
      const capped =
        /** @type {import('@arkade-os/sdk').PaymentRequest & { maxFee?: number | bigint }} */ (req);
      if (capped.maxFee === undefined || req.selectedVtxos) return rail.quote(req, ctx);
      const fees = await feeInfo();
      const estimator = new Estimator(fees.intentFee ?? {});
      const candidates = (
        await ctx.wallet.getSpendableVtxos({
          withRecoverable: true,
          withUnrolled: false,
          genericallySpendableOnly: true,
        })
      ).filter(
        (coin) =>
          !coin.assets?.length &&
          estimator.evalOffchainInput(toOffchainInputFeeParams(coin)).satoshis < coin.value
      );
      const fixedRail = onchainRail({ feeInfo: async () => fees });
      const dust = BigInt(
        /** @type {import('@arkade-os/sdk').Wallet} */ (ctx.wallet).dustAmount ?? 330
      );
      let target = BigInt(resolveSendAmount(rail.id, req.raw, req.amount));
      for (;;) {
        const selectedVtxos =
          /** @type {import('@arkade-os/sdk').NormalizedExtendedVirtualCoin[]} */ (
            selectVirtualCoins(candidates, safeOnchainSats(target)).inputs
          );
        const available = selectedVtxos.reduce((sum, coin) => sum + BigInt(coin.value), 0n);
        safeOnchainSats(available);
        const quote = await fixedRail.quote({ ...req, selectedVtxos }, ctx);
        const total = BigInt(safeOnchainSats(quote.total));
        const change = available - total;
        if (change === 0n || change >= dust) return quote;
        if (selectedVtxos.length === candidates.length) {
          if (change < 0n) {
            throw new Error('Insufficient funds to cover the onchain payment and fees');
          }
          throw new DustChangeError(change, dust);
        }
        target = change > 0n ? available + 1n : total;
      }
    },
  };
}

/**
 * @typedef {{ router: import('@arkade-os/lnurl-client/arkade').LnurlPaymentRouter;
 *   to: string; amount: bigint; assets?: import('@arkade-os/sdk').Asset[]; maxFee?: number | bigint;
 *   signal?: AbortSignal; paymentTimeoutMs?: number;
 *   trackCompletion?: (completion: Promise<import('@arkade-os/sdk').RouteResult>) => void }} SendOptions
 */

/** @param {SendOptions} options */
function paymentRequest({ to, amount, assets, maxFee }) {
  if (amount < 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Amount must be a non-negative safe integer number of satoshis');
  }
  const uriAmount = BIP21.amountSats(to);
  if (uriAmount !== undefined && amount > 0n && BigInt(uriAmount) !== amount) {
    throw new Error('Amount mismatch with BIP21 URI');
  }
  if (assets?.length && !arkTarget(to)) {
    throw new Error('Asset transfers require an Arkade address');
  }
  let raw = to;
  if (to.toLowerCase().startsWith('bitcoin:') && !arkTarget(to)) {
    const target = BIP21.parse(to).params.lightning;
    if (typeof target === 'string' && isLnurl(target)) raw = target;
  }
  const sats = amount > 0n ? Number(amount) : uriAmount;
  return {
    raw,
    ...(sats !== undefined ? { amount: sats } : {}),
    ...(assets ? { assets } : {}),
    ...(maxFee !== undefined ? { maxFee } : {}),
  };
}

/** @param {SendOptions} options */
async function routePayment(options) {
  const request = paymentRequest(options);
  const quote = await options.router.route(request, { priority: DEFAULT_RAIL_PRIORITY });
  if (request.amount !== undefined && quote.amount !== request.amount) {
    throw new Error('Amount mismatch with payment quote');
  }
  return quote;
}

/** @param {SendOptions} options */
export async function quoteSend(options) {
  const quote = await routePayment(options);
  return { fee: BigInt(quote.fee), total: BigInt(quote.total) };
}

/** @param {SendOptions} options */
export async function send(options) {
  throwIfAborted(options.signal);
  const timeoutMs = options.paymentTimeoutMs ?? 120_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2 ** 31 - 1) {
    throw new RangeError('Payment timeout must be a positive integer of at most 2147483647 ms');
  }
  const quote = await withAbort(routePayment(options), options.signal);
  throwIfAborted(options.signal);
  const fee = BigInt(quote.fee);
  if (options.maxFee !== undefined && fee > BigInt(options.maxFee)) {
    throw new MaximumFeeExceededError('Payment fee exceeds the configured maximum.', {});
  }
  const handle = await quote.send();
  let result;
  try {
    options.trackCompletion?.(handle.settled());
    result = await handle.settled({ timeoutMs });
  } catch (error) {
    throw Object.assign(
      error instanceof Error ? error : new Error('Payment settlement failed', { cause: error }),
      {
        paymentId: handle.id,
        railId: quote.railId,
      }
    );
  }
  return { txid: result.txid ?? result.preimage ?? result.swapId ?? handle.id, fee };
}
