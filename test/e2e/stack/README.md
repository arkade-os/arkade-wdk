# Funded WDK regtest

Requires Docker Compose 2.24.4+, Git, OpenSSL, and the Node version in package.json.
These fixtures use only public regtest keys. Generated keys, certificates, wallets,
and the pinned official regtest clone stay in ignored `.cache/arkade-wdk-e2e/`.
Never fund these keys outside regtest. No global certificate trust is changed.

Run from the repository root. On Windows, when OpenSSL is not on PATH, set
`$env:OPENSSL_BIN="$env:ProgramFiles/Git/usr/bin/openssl.exe"` first.

```text
node test/e2e/stack/stack.mjs prepare
node test/e2e/stack/stack.mjs check
node .cache/arkade-wdk-e2e/regtest/regtest.mjs start --env .cache/arkade-wdk-e2e/stack.env --profile ark --profile emulator --profile lightning --profile nostr --profile covclaimd
node test/e2e/stack/stack.mjs compose up -d --wait nostr-tls intent-solver
node test/e2e/stack/stack.mjs fund
node test/e2e/stack/stack.mjs cards
node test/e2e/stack/stack.mjs compose up -d --wait lnurl-server
```

Wait for solver health and `http://localhost:57032/readyz` to report ready before
testing. `cards` preserves the solver's signature and writes a pointer-only registry
at `https://localhost:57033/registry.json`; markets must resolve through real Nostr.
The TLS proxy exists because signed cards require WSS. Both host and container
relay URLs are advertised without rewriting signed fields.

PowerShell:

```powershell
$env:NODE_EXTRA_CA_CERTS=(Resolve-Path .cache/arkade-wdk-e2e/tls/cert.pem).Path
npm run test:e2e
```

POSIX shell:

```sh
export NODE_EXTRA_CA_CERTS="$PWD/.cache/arkade-wdk-e2e/tls/cert.pem"
npm run test:e2e
```

Arkd is `http://localhost:57020`, Esplora `http://localhost:57000/api`, emulator
`http://localhost:57023`, and LNURL `http://localhost:57032` with domain `localhost`.
The baseUrl hostname and domain must match to preserve its port in receiver URLs.
LNURL 0.6.0 emits domain callbacks without ports, so this fixture also binds the
same LNURL service to `127.0.0.1:80`; that port must be free before startup.
LNURL 0.6.0 supports explicit named/random address claims and interactive POST-SSE
sessions. It does not support nameless address allocation or emit `invoice_settled`
SSE frames; the test verifies reported settlement through `pollVerify()`.
The solver uses LND directly. Its roughly balanced 1,000,000-sat channel is
bootstrapped by the official CLI; automining is disabled, so the test controls it.

The default project is `arkade-wdk-e2e`, prefix `wdk-e2e-`, ports 57000–57033 plus local 80,
subnet `10.222.57.0/24`. Do not start another stack using those names or ports.
`WDK_E2E_STATE` may select another state directory for the helper; adjust the
literal official-CLI paths above accordingly. Existing Docker stacks are preserved.
`prepare` binds every published port in the pinned official Compose files to
`127.0.0.1`, including Postgres with regtest trust authentication. `check` rejects
any published port without that explicit loopback address before starting services.

Stop and retain recovery evidence:

```text
node test/e2e/stack/stack.mjs compose stop intent-solver lnurl-server nostr-tls
node .cache/arkade-wdk-e2e/regtest/regtest.mjs stop --env .cache/arkade-wdk-e2e/stack.env
```

Critical versions: official regtest commit `f7c09c136fe316142ba2e9686921f40eae9d7a84`
(arkd/wallet/signer 0.9.25, emulator 0.0.9, covclaimd rc.5), intent-solver 0.5.0,
LNURL server 0.6.0, and digest-pinned Nostr/TLS proxies. The helper never cleans
volumes or stops another project. Regenerate expired test certificates before reuse.

The funded test covers Arkade and asset transfers, boarding/onboarding, a capped
onchain payout with token preservation, signature verification, signed Nostr
discovery, both Lightning directions, pending-swap recovery after restart, reusable
LNURL receiving, offline exact-net Lightning receiving, payment sync, and an
interactive session with verified settlement and explicit teardown.

After applying and building the three submodule patches, run the sample service
harness against this same stack with `npm run test:e2e:sample`. Optional
`ARKADE_E2E_PEAR_DIR`, `ARKADE_E2E_PROVIDER_DIR`, and `ARKADE_E2E_SAMPLE_DIR` point to
other patched checkouts. The harness executes original sample-service methods and
real HRPC bindings, substituting Node adapters for device APIs. It also tests
reset, new-seed isolation in one SQLite database, and restoration of the old seed.
An Android/iOS app run remains a separate validation step.
