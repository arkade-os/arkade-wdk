import {
  BIP21,
  PaymentRouter,
  arkRail,
  arkAssetRail,
  onchainRail,
  createDefaultPaymentRouter,
  arkTarget,
  isLnurl,
} from '@arkade-os/sdk';
import { lightningRail } from '@arkade-os/swap';
import { createLnurlClient } from '@arkade-os/lnurl-client';
import { MaximumFeeExceededError } from '@tetherto/wdk-wallet';
import { withAbort } from './abort.js';
import {
  arkadePaymentRouter,
  DEFAULT_RAIL_PRIORITY,
  lnurlRails,
} from '@arkade-os/lnurl-client/arkade';

/**
 * @param {import('@arkade-os/sdk').IWallet} wallet
 * @param {{ solver?: import('@arkade-os/swap').SwapRailClient | null; client?: import('@arkade-os/lnurl-client').LnurlClient }} [options]
 * @returns {import('@arkade-os/lnurl-client/arkade').LnurlPaymentRouter}
 */
export function createPaymentRouter(wallet, { solver = null, client } = {}) {
  const router = createDefaultPaymentRouter(
    /** @type {import('@arkade-os/sdk').Wallet} */ (wallet)
  );
  const rail = solver ? lightningRail(solver) : undefined;
  return arkadePaymentRouter({ wallet, router, lightning: rail, client });
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
    .use(onchainRail({ feeInfo: async () => (await arkInfo).fees }));
  for (const rail of lnurlRails({ client: createLnurlClient(), arkade: arkRail() })) {
    router.use(rail);
  }
  return router;
}

/**
 * @typedef {{ router: import('@arkade-os/lnurl-client/arkade').LnurlPaymentRouter;
 *   to: string; amount: bigint; assets?: import('@arkade-os/sdk').Asset[]; maxFee?: number | bigint; signal?: AbortSignal }} SendOptions
 */

/** @param {SendOptions} options */
function paymentRequest({ to, amount, assets }) {
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
  options.signal?.throwIfAborted();
  const quote = await withAbort(routePayment(options), options.signal);
  options.signal?.throwIfAborted();
  const fee = BigInt(quote.fee);
  if (options.maxFee !== undefined && fee > BigInt(options.maxFee)) {
    throw new MaximumFeeExceededError('Payment fee exceeds the configured maximum.', {});
  }
  const handle = await quote.send();
  const result = await handle.settled();
  return { txid: result.txid ?? result.preimage ?? result.swapId ?? handle.id, fee };
}
