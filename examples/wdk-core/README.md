# Arkade WDK Core regtest example

This example runs a read-only Arkade module on the upstream Pear worklet used by
[WDK React Native Core 1.0.0-beta.24](https://docs.wdk.tether.io/tools/react-native-core/).
It uses Pear `1.0.0-beta.15` and the official Worklet Bundler without patching HRPC.
The Bitcoin entry satisfies Core's requirement for a wallet network. The smoke only
requests its address to verify that closing Arkade leaves the other wallet usable.

Start the [local regtest stack](../../test/e2e/stack/README.md). From the repository
root, use Node 22.21+ on the 22 release line or Node 24.9–26:

```text
npm ci --include=dev
npm ci --prefix examples/wdk-core --include=dev --strict-peer-deps
npm test --prefix examples/wdk-core
```

The test builds for the current host and runs the packed bundle in Bare over an
ephemeral loopback socket. It uses public, unfunded fixture seeds, checks a real
regtest address and balance, and exercises RPC allowlisting, close, seed isolation,
and restore. This harness has been run on Windows x64.
Keep these wallets on regtest. The module requires loopback URLs and rejects an
operator that identifies itself as a different network. It uses the SDK's built-in
Esplora HTTP polling because Bare's WebSocket lacks the expected event API.

The Expo 56 app uses Core's `WdkAppProvider` and `useModule` with the same worklet.
For an Android development build, install the Android SDK, NDK, and JDK, connect
an emulator or device, and run these commands from this directory:

```text
npm run prebuild:android
adb reverse tcp:57020 tcp:57020
adb reverse tcp:57000 tcp:57000
adb reverse tcp:8081 tcp:8081
npx expo run:android --no-bundler
npm start -- --localhost
```

`prebuild:android` generates the ARM64 and x86-64 addon sets and pins the build template,
Gradle, and Bare Kit runtime. The app uses a separate application ID and storage.
Set a screen lock on the test device to create or reopen a wallet. The screen can
show its receive address and balances, and locks only after the worklet confirms
the Arkade module is closed.

If Metro binds only to IPv6 on Windows, set
`$env:NODE_OPTIONS='--dns-result-order=ipv4first'` in its PowerShell terminal before
starting it so the emulator's IPv4 reverse connection can reach it.

The iOS worklet graph can be packed with `npm run bundle:mobile -- ios`, but
native iOS addon linkage still needs verification. Sending, migration of legacy
Keychain and SQLite state, and durable swap recovery are outside this example.

The Android 15 x86-64 emulator run verified authenticated creation, a 3,000-sat
regtest credit, balance refresh, lock, and reopening the same address and balance
after a process restart.
