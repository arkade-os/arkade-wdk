# AGENTS.md

Guidance for coding agents working in this repository. Also follow applicable
user-level instructions and selectively consult available project plans and
handoffs before continuing existing work.

When interacting with Cloudflare, use `cf` unless the project has Wrangler config.

## Package and source

- The root package is `@arkade-os/wdk`, a WDK-compatible Bitcoin wallet adapter.
- Source is JavaScript ESM with JSDoc types, checked by TypeScript. Target ES2022;
  runtime Node.js `>=22.13.0 <27`.
- `src/wallet-manager-arkade.js` derives and caches SDK wallets per account path.
- `src/wallet-account-arkade.js` implements signing, sending, and LNURL receiving.
- `src/wallet-account-read-only-arkade.js` implements query and quote methods.
- `src/lib/send.js` composes SDK, swap, and LNURL payment rails.
- `src/index.js` exports the manager and two account classes. `src/lib/*` is internal.
- `npm run build:types` generates declarations in ignored `types/`. There is no
  root JavaScript build or dev/watch script.

## Shared package boundaries

- Use `@arkade-os/sdk` payment rails, fee helpers, wallet helpers, and readonly
  conversion instead of duplicating their implementation.
- Use `@arkade-os/lnurl-client` and its `/arkade` facade for LNURL payer and receiver
  operations. Receiver registration is explicit; account creation must not claim
  names or allocate receivers.
- Use `@arkade-os/swap` for solver discovery, signed card validation, Nostr RFQ,
  persistence, and recovery. `nostr-tools` provides the default Nostr transport.
- Solver configuration requires a caller-supplied persistent repository per
  account path. Do not introduce an in-memory fallback for active swaps.
- Boltz support has been removed. Do not restore its dependency, configuration, or
  legacy account methods.
- Keep accepted/funded payments attached to the chosen client and solver. Do not
  fail over after payment execution begins.
- Preserve the WDK send `{ hash, fee }` and quote `{ fee }` shapes and bigint fees.
- Readonly accounts must not acquire signing identities or payment execution APIs.
- Await disposal in tests and callers that require completed teardown.

## Verification

```bash
npm install
npm run lint
npm test
npm run build:types
```

- Tests use `node:test`; there is no Jest setup dependency.
- Lint runs ESLint and `tsc --noEmit` over checked JavaScript.
- Add meaningful tests for payment validation, lifecycle changes, and trust
  boundaries. Never skip failing tests to make a gate pass.
- SDK and LNURL package versions may change independently; verify published
  declarations rather than relying on old API names or repository docs.
- Use Slopo when requested or when a configured repository requires it; review
  real duplication rather than treating every similarity as a defect.

## Coding conventions

- Two spaces, single quotes, semicolons, print width 100.
- Preserve `.js` extensions in relative ESM imports.
- No unused variables; unused arguments may start with `_`.
- Prefer deleting superseded protocol code to introducing another abstraction.
- Keep README and generated public declarations aligned with actual behavior.

## React Native submodules and patches

Independent repositories:

- `packages/pear-wrk-wdk`
- `packages/wdk-react-native-provider`
- `examples/wdk-starter-react-native`

The provider/worklet integration is maintained through `patches/`. A root change
does not prove that a native app uses it: inspect current dependency wiring and
links before claiming in-app validation.

Before editing a submodule, check root and submodule `git status --short`, fetch
its remote, and check branch freshness as required by the global instructions.
Preserve existing dirty work. Submodule changes are separate deliverables from
root adapter changes.

`npm run setup:dev` initializes submodules, applies patches, installs dependencies,
and links local packages. Verify its results explicitly. Use
`node scripts/apply-patches.js --check` to check patches and
`node scripts/generate-patches.js` after editing a submodule. Build affected
packages, re-link as needed, and run the example's available checks plus Android
or iOS validation before making native runtime claims.

Review root and touched-submodule status before handoff. Include only intentional
dependency and lockfile changes, report verification limits, and keep plans/specs
outside commits unless explicitly requested.
