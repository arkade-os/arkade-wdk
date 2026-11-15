# @arkade-os/wdk

A WDK-compatible Bitcoin wallet adapter built on `@arkade-os/sdk`, with solver swaps
from `@arkade-os/swap` and LNURL sending and receiving from `@arkade-os/lnurl-client`.

Requires Node.js `>=22.13.0 <27`. The package ships JavaScript ESM and generated TypeScript declarations.

## Install

```bash
npm install @arkade-os/wdk @tetherto/wdk
```

The adapter installs its SDK, swap, LNURL, and Nostr dependencies. Add a package as a
direct dependency when your application imports it directly.

## Wallet accounts

```javascript
import WalletManagerArkade from '@arkade-os/wdk';

const manager = new WalletManagerArkade(seedPhrase, {
  arkServerUrl: 'https://arkade.computer',
});
const account = await manager.getAccount(0);

const address = await account.getAddress();
const boardingAddress = await account.getBoardingAddress();
const balance = await account.getBalance();
const estimate = await account.quoteSendTransaction({ to: recipient, value: 1000n });
const result = await account.sendTransaction({ to: recipient, value: 1000n });

await manager.dispose();
```

`getAccount(index)` derives `m/86'/<coin>/0'/0/<index>`, with coin `0` for Bitcoin
mainnet and `1` for other networks. Each path has its own cached SDK wallet and
account. Only seed-derived accounts are supported.

The manager can also be registered with `@tetherto/wdk` through
`wdk.registerWallet('bitcoin', WalletManagerArkade, config)`. Await the adapter
manager's `dispose()` when complete teardown must finish before the process exits.

## Sending and quotes

`sendTransaction()` and `quoteSendTransaction()` use the SDK payment router and the
LNURL client's rails. Supported targets include Arkade addresses, Bitcoin addresses,
BOLT11 invoices, Lightning addresses, LNURLs, and BIP21 payment URIs.

```javascript
const { hash, fee } = await account.sendTransaction({
  to: 'recipient@arkade.money',
  value: 1000n,
});
```

The return shapes follow WDK: sends return `{ hash, fee }`, and quotes return
`{ fee }`, with fees in bigint satoshis. Quotes do not spend. A send executes one
chosen quote and waits for its payment handle to settle. Settlement errors do not
retry through another solver or payment rail.

Arkade transfers use the SDK's zero-fee offchain rail. Bitcoin payments use the
SDK's collaborative exit rail and operator fee schedule. Solver-backed Lightning
requires the solver configuration below. An LNURL offering a direct Arkade payment
can be paid without a Lightning solver.

```javascript
await account.transfer({ token: assetId, recipient: arkadeAddress, amount: 100n });
const estimate = await account.quoteTransfer({
  token: assetId,
  recipient: arkadeAddress,
  amount: 100n,
});
```

The SDK supplies the asset output's satoshi carrier and validates supported routes.
The adapter does not estimate fees from fixed transaction sizes.

## Solver discovery and Lightning

Configure a persistent swap repository for every account path. For example, in a
browser with IndexedDB:

```javascript
import { IndexedDbAssetSwapRepository } from '@arkade-os/swap';

const manager = new WalletManagerArkade(seedPhrase, {
  arkServerUrl: 'https://arkade.computer',
  solver: (path) => ({
    repository: new IndexedDbAssetSwapRepository(`wdk-swaps:${path}`),
  }),
});
const account = await manager.getAccount(0);
const markets = await account.swapClient.markets();
const receive = await account.swapClient.receive({ via: 'lightning', amount: 50_000n });
console.log(receive.artifact.bolt11);
```

`@arkade-os/swap` supplies registry allowlists, verified signed solver cards,
Nostr card discovery, and directed Nostr RFQ transport. `nostr-tools` is installed
for those default transports. Optional `discovery`, `policy`, and corridor settings
are passed to `createSwapClient()`; the adapter does not implement another discovery
or recovery layer.

`account.swapClient` is available only when `solver` is configured. Use its
`markets()`, `swaps()`, `onUpdate()`, and recovery APIs directly. The manager awaits
its persisted-state readiness before returning the account. Keep each account's
repository separate and retain it across restarts. The caller owns and closes an
injected repository.

The adapter has no Boltz dependency or Boltz configuration. The former
`swapProviderUrl`, `swapRepository`, `arkadeSwaps`, and Boltz-specific invoice,
history, limits, and fee methods have been removed. Use `account.swapClient` for
solver invoices and lifecycle queries.

## LNURL receiving

`account.getLnurl()` returns the LNURL client's SDK facade. It exposes ownership
discovery, registration, destination binding, address management, and payment reads
without recreating the protocol in the adapter.

```javascript
const lnurl = account.getLnurl();
let receiver = await lnurl.owned();
if (!receiver) receiver = await lnurl.claim({ nameless: true });

console.log(receiver.lnurl, receiver.lightningAddress);
const request = await receiver.payRequest();
const payments = await receiver.payments();
```

Registration is explicit: constructing an account does not claim a name or create
a receiver. `claim({ username, claimCode })` can claim a named address when the
server permits it. `owned({ refresh: true })` rebinds owned addresses to the current
wallet destinations. The facade also exposes `addresses()`, `capabilities()`,
`sessionLnurl()`, and `token()`. A receiver supports `upgrade()`, `payments()`, and
`sync()`; supply `lnurl.store` when integrating payment synchronization with local
storage.

Default services follow the wallet's operator network:

| Network | Service | Lightning address domain |
| --- | --- | --- |
| Bitcoin mainnet | `https://lnurl.arkade.sh` | `arkade.money` |
| Mutinynet | `https://lnurl.mutinynet.arkade.sh` | `lnurl.mutinynet.arkade.sh` |

Other networks require explicit LNURL configuration. Override `lnurl` to use a
custom service, domain, transport, payment store, or advertised payment methods:

```javascript
const manager = new WalletManagerArkade(seedPhrase, {
  arkServerUrl: 'https://arkade.computer',
  lnurl: {
    baseUrl: 'https://lnurl.arkade.sh',
    domain: 'arkade.money',
  },
});
```

`getLnurlClient()` exposes the package's low-level client for management and payer
operations. `openLnurlSession(handlers, options?)` opens an interactive POST-SSE
receiver session with an identity-derived token unless `options.token` is supplied.
The required `onInvoiceRequest` handler answers or rejects payer requests through
the package's responder. Call `session.reportSettled(preimage)` after verified local
settlement and `session.close()` when finished. Account disposal closes its sessions
and aborts pending session opens.

## Account APIs

The package exports `WalletManagerArkade` as its default, plus
`WalletAccountArkade`, `WalletAccountReadOnlyArkade`, and the `ArkadeWalletConfig`
type. Internal modules under `src/lib/` are not public exports.

Both account types provide addresses, balance and token balance, transaction
history, transaction reads, signature verification, and fee quotes. Full accounts
also provide sending, asset transfers, BIP-322 signing, incoming-fund subscriptions,
LNURL receiving, and `toReadOnlyAccount()`.

`toReadOnlyAccount()` uses the SDK's `toReadonly()` helper. It supplies no signing
identity, payment execution methods, or swap client to the returned account.
`signTransaction()` is unsupported because Arkade requires operator cosigning;
use `sendTransaction()`.

`getTransaction(hash)` normalizes SDK history to WDK finality: settled entries are
`confirmed`, and unsettled entries are `pending`. An unknown transaction throws
`NoSuchElementError`. This does not claim Bitcoin finality. The legacy
`getTransactionReceipt()` returns the native indexer response.

Await account or manager disposal to close sessions, drain swap work, and erase
private key material. Manager disposal also closes the SDK wallets.

## Configuration and persistence

`ArkadeWalletConfig` combines WDK fee limits with SDK `WalletConfig` options except
`identity`, which the adapter derives. `arkServerUrl` remains a convenience for an
operator URL; custom SDK providers can be supplied for other transports.

| Field | Purpose |
| --- | --- |
| `storage` | SDK wallet and contract repositories; defaults to in-memory storage for runtimes without IndexedDB. |
| `solver(path)` | Per-account swap client configuration with an explicit persistent repository. |
| `lnurl` | LNURL service, domain, client, payment store, and advertised methods. |

In-memory wallet storage is session-local. Production applications should supply
persistent SDK repositories as well as a persistent solver repository. Funding,
accepted swaps, and recovery state must remain with the same account and selected
solver across restarts.

## Development

```bash
npm install
npm run lint
npm test
npm run build:types
```

Tests use Node's built-in test runner. Lint includes checked JavaScript via
`jsconfig.json`. `build:types` generates declarations in ignored `types/`; there is
no JavaScript compilation step. `npm run format` formats source files.

The package pins SDK `0.5.6`, swap `0.1.6`, lnurl-client `0.9.4`, and nostr-tools
`2.24.1`. Nostr is pinned to the swap package's exact peer version. Update those
packages together and validate the generated declarations.

## React Native submodules

`packages/pear-wrk-wdk`, `packages/wdk-react-native-provider`, and
`examples/wdk-starter-react-native` are independent git submodules. Their local
integration changes are stored under `patches/`.

The patches use persistent solver storage and expose reusable LNURL receiving in
the example. Old swap tables are retained and are not interpreted as v2 records.

```bash
npm run setup:dev
node scripts/apply-patches.js --check
```

Setup initializes submodules, applies patches, installs dependencies, and links the
packages. Verify the links and build commands in each submodule. Root Node tests
do not validate Android, iOS, Bare, or Expo runtime behavior. After changing a
submodule, regenerate its patch with `node scripts/generate-patches.js` and build
the affected package before testing the example app.

## Releases

`npm run release` runs the local release script. It publishes the current package
version and creates/pushes its tag; `prepublishOnly` regenerates declarations.
Version bumps, publication, and tag pushes are separate operator actions, not part
of normal dependency installation or validation.

## License

MIT
