import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EsploraProvider, RestEmulatorProvider, Ramps } from '@arkade-os/sdk';
import {
  SQLiteWalletRepository,
  SQLiteContractRepository,
  SQLiteIntentRepository,
} from '@arkade-os/sdk/repositories/sqlite';
import { SQLiteAssetSwapRepository } from '@arkade-os/swap/repositories/sqlite';
import { closeSharedNostrPool } from '@arkade-os/swap/nostr';
import { createLnurlPaymentRepository } from '@arkade-os/lnurl-client';
import WalletManagerArkade from '../../src/index.js';

const run = promisify(execFile);
const operatorUrl = process.env.ARKADE_E2E_SERVER_URL ?? 'http://127.0.0.1:57020';
const esploraUrl = process.env.ARKADE_E2E_ESPLORA_URL ?? 'http://127.0.0.1:57000/api';
const emulatorUrl = process.env.ARKADE_E2E_EMULATOR_URL ?? 'http://127.0.0.1:57023';
const prefix = process.env.ARKADE_E2E_CONTAINER_PREFIX ?? 'wdk-e2e-';
const registryUrl = process.env.ARKADE_E2E_REGISTRY_URL ?? 'https://localhost:57033/registry.json';
const lnurlUrl = process.env.ARKADE_E2E_LNURL_URL ?? 'http://localhost:57032';

test('WDK funded regtest lifecycle', { timeout: 600_000 }, async () => {
  const info = await json(`${operatorUrl}/v1/info`);
  assert.equal(info.network, 'regtest', 'This test only spends regtest coins');
  const directory = await mkdtemp(join(tmpdir(), 'arkade-wdk-e2e-'));
  const sender = localWallet(join(directory, 'sender.sqlite'), randomBytes(32));
  const receiver = localWallet(join(directory, 'receiver.sqlite'), randomBytes(32));
  try {
    const account = await sender.manager.getAccount();
    const destination = await receiver.manager.getAccount();
    const address = await account.getAddress();
    const receiveAddress = await destination.getAddress();
    report('wallets-created', { address, receiveAddress, directory });
    await docker(
      'arkd',
      'ark',
      'send',
      '--to',
      address,
      '--amount',
      '200000',
      '--password',
      'secret'
    );
    await until(async () => (await account.getBalance()) >= 200000n, 'offchain funding');
    report('offchain-funded', { address, balance: await account.getBalance() });

    const signature = await account.sign('WDK regtest end-to-end');
    assert.equal(await account.verify('WDK regtest end-to-end', signature), true);
    assert.equal(await account.verify('a different message', signature), false);
    const readonly = await account.toReadOnlyAccount();
    assert.equal(await readonly.getBalance(), await account.getBalance());
    assert.equal(typeof readonly.sendTransaction, 'undefined');
    await readonly.dispose();

    const quote = await account.quoteSendTransaction({ to: receiveAddress, value: 5000n });
    const sent = await account.sendTransaction({ to: receiveAddress, value: 5000n });
    assert.equal(sent.fee, quote.fee);
    await until(async () => (await destination.getBalance()) === 5000n, 'Arkade transfer');
    assert.ok(
      (await account.getTransactionHistory()).some((tx) =>
        Object.values(tx.key).includes(sent.hash)
      )
    );
    report('arkade-transfer', sent);

    const asset = await account._wallet.assetManager.issue({ amount: 100n });
    await until(
      async () => (await account.getTokenBalance(asset.assetId)) === 100n,
      'asset issuance'
    );
    const transferred = await account.transfer({
      token: asset.assetId,
      recipient: receiveAddress,
      amount: 10n,
    });
    await until(
      async () => (await destination.getTokenBalance(asset.assetId)) === 10n,
      'asset transfer'
    );
    assert.equal(await account.getTokenBalance(asset.assetId), 90n);
    report('asset-transfer', { assetId: asset.assetId, ...transferred });

    const boardingAddress = await destination.getBoardingAddress();
    await faucet(boardingAddress, '0.001');
    await until(
      async () => (await destination._wallet.getBoardingUtxos()).length > 0,
      'boarding UTXO'
    );
    const onboarded = await new Ramps(destination._wallet).onboard(
      (await destination._wallet.getOperatorInfo()).fees
    );
    await until(
      async () => (await destination._wallet.getBalance()).settled > 5000,
      'onboarding settlement'
    );
    report('boarding-onboarded', { boardingAddress, txid: onboarded });

    const payout = (
      await docker(
        'bitcoin',
        'bitcoin-cli',
        '-regtest',
        '-rpcuser=admin1',
        '-rpcpassword=123',
        '-rpcwallet=default',
        'getnewaddress'
      )
    ).trim();
    assert.ok((await account._wallet.getSpendableVtxos()).every((coin) => coin.assets.length > 0));
    await assert.rejects(
      account.quoteSendTransaction({ to: payout, value: 10000n }),
      /Insufficient funds/
    );
    const beforeFunding = await account.getBalance();
    await docker(
      'arkd',
      'ark',
      'send',
      '--to',
      address,
      '--amount',
      '50000',
      '--password',
      'secret'
    );
    await until(
      async () => (await account.getBalance()) === beforeFunding + 50000n,
      'plain BTC exit input'
    );
    const onchainQuote = await account.quoteSendTransaction({ to: payout, value: 10000n });
    const before = await account.getBalance();
    const exited = await account.sendTransaction({ to: payout, value: 10000n });
    await until(
      async () =>
        (await json(`${esploraUrl}/address/${payout}/utxo`)).some((coin) => coin.value === 10000),
      'exact onchain payout'
    );
    await until(
      async () => before - (await account.getBalance()) === 10000n + exited.fee,
      'exact onchain fee'
    );
    assert.equal(exited.fee, onchainQuote.fee);
    assert.equal(await account.getTokenBalance(asset.assetId), 90n);
    report('onchain-exit', {
      ...exited,
      recipientSats: 10000,
      balanceDebit: before - (await account.getBalance()),
    });

    const retained = await account.getBalance();
    const retainedAssets = await account.getTokenBalance(asset.assetId);
    await sender.manager.dispose();
    sender.manager = sender.reopen();
    const restarted = await sender.manager.getAccount();
    assert.equal(await restarted.getAddress(), address);
    assert.equal(await restarted.getBalance(), retained);
    assert.equal(await restarted.getTokenBalance(asset.assetId), retainedAssets);
    report('restart-restored', {
      address,
      balance: retained,
      assetAmount: retainedAssets,
      directory,
    });

    const markets = await restarted.swapClient.markets();
    assert.ok(markets.length > 0, 'A pointer-only registry must resolve signed Nostr cards');
    report('nostr-discovery', { markets: markets.map((market) => market.key) });

    const invoice = JSON.parse(
      await docker(
        'lnd-peer',
        'lncli',
        '--network=regtest',
        'addinvoice',
        '--amt=2000',
        '--memo=WDK-regtest-send'
      )
    );
    const lightning = await restarted.sendTransaction({
      to: invoice.payment_request,
      value: 2000n,
    });
    const invoiceState = JSON.parse(
      await docker('lnd-peer', 'lncli', '--network=regtest', 'lookupinvoice', invoice.r_hash)
    );
    assert.equal(invoiceState.state, 'SETTLED');
    report('lightning-send', lightning);

    const receiveBefore = await destination.getBalance();
    const incoming = await destination.swapClient.receive({ via: 'lightning', amount: 5000n });
    assert.equal(incoming.artifact.kind, 'invoice');
    await docker(
      'lnd-peer',
      'lncli',
      '--network=regtest',
      'payinvoice',
      '--force',
      '--json',
      incoming.artifact.bolt11
    );
    await until(
      async () =>
        (await destination.swapClient.swaps()).some(
          (swap) => swap.id === incoming.id && swap.outcome === 'claimed'
        ),
      'Lightning receive claim'
    );
    await until(
      async () => (await destination.getBalance()) === receiveBefore + 5000n,
      'Lightning receive credit'
    );
    report('lightning-receive', { swapId: incoming.id, receivedSats: 5000 });

    const pending = await destination.swapClient.receive({ via: 'lightning', amount: 2500n });
    await receiver.manager.dispose();
    receiver.manager = receiver.reopen();
    const restoredReceiver = await receiver.manager.getAccount();
    assert.ok((await restoredReceiver.swapClient.swaps()).some((swap) => swap.id === pending.id));
    await docker(
      'lnd-peer',
      'lncli',
      '--network=regtest',
      'payinvoice',
      '--force',
      '--json',
      pending.artifact.bolt11
    );
    await until(
      async () =>
        (await restoredReceiver.swapClient.swaps()).some(
          (swap) => swap.id === pending.id && swap.outcome === 'claimed'
        ),
      'restored Lightning receive'
    );
    await until(
      async () => (await restoredReceiver.getBalance()) === receiveBefore + 7500n,
      'restored Lightning credit'
    );
    report('lightning-restart-recovery', { swapId: pending.id });

    const registered = await restoredReceiver.getLnurl().claim({ username: `wdk${Date.now()}` });
    const owned = await restoredReceiver.getLnurl().owned({ refresh: true });
    assert.equal(owned.handle, registered.handle);
    const lnurlBefore = await restoredReceiver.getBalance();
    const lnurlPayment = await restarted.sendTransaction({ to: registered.lnurl, value: 3000n });
    await until(
      async () => (await restoredReceiver.getBalance()) === lnurlBefore + 3000n,
      'LNURL Arkade credit'
    );
    const payments = await registered.payments();
    assert.ok(payments.payments.length > 0);
    report('lnurl-arkade-receive', {
      handle: registered.handle,
      receivedSats: 3000,
      ...lnurlPayment,
    });

    const payer = restarted.getLnurlClient();
    const payRequest = await registered.payRequest();
    const lightningOption = payRequest.paymentOptions.find((option) => option.type === 'lightning');
    assert.ok(lightningOption?.available !== false);
    assert.equal(payRequest.receiveAmountAllowed, true);
    const offlineInvoice = await payer.requestInvoice(payRequest, {
      paymentOption: lightningOption.id,
      amountSat: 2000,
      receiveAmountSat: 1500,
    });
    assert.equal(offlineInvoice.kind, 'bolt11');
    const offlineBefore = await restoredReceiver.getBalance();
    await receiver.manager.dispose();
    await docker(
      'lnd-peer',
      'lncli',
      '--network=regtest',
      'payinvoice',
      '--force',
      '--json',
      offlineInvoice.pr
    );
    await payer.pollVerify(offlineInvoice.verify, { timeoutMs: 120000 });
    receiver.manager = receiver.reopen();
    const onlineReceiver = await receiver.manager.getAccount();
    await until(
      async () => (await onlineReceiver.getBalance()) === offlineBefore + 1500n,
      'offline LNURL exact receive'
    );
    const rebound = await onlineReceiver.getLnurl().owned({ refresh: true });
    const synced = await rebound.sync();
    assert.deepEqual(synced.failures, []);
    const firstSync = await receiver.payments.all();
    assert.ok(firstSync.some((payment) => payment.settled && payment.kind === 'bolt11'));
    await rebound.sync();
    assert.equal((await receiver.payments.all()).length, firstSync.length);
    report('lnurl-offline-lightning', {
      handle: rebound.handle,
      receivedSats: 1500,
      synced: synced.synced,
    });

    let liveReceive;
    const session = await onlineReceiver.openLnurlSession(
      {
        async onInvoiceRequest(request, respond) {
          assert.equal(request.amountMsat, 1000000);
          const quote = await onlineReceiver.swapClient.quote({
            via: 'lightning',
            amount: BigInt(request.amountMsat / 1000),
            amountOn: 'give',
          });
          assert.equal(quote.give.amount, 1000n);
          assert.equal(quote.take.amount + quote.fee.amount, 1000n);
          liveReceive = await onlineReceiver.swapClient.accept(quote);
          await respond.answerInvoice(liveReceive.artifact.bolt11);
        },
      },
      { reconnect: false }
    );
    assert.equal(session.token, await onlineReceiver.getLnurl().token());
    try {
      const liveBefore = await onlineReceiver.getBalance();
      const sessionRequest = await payer.resolve(session.lnurl);
      const liveInvoice = await payer.requestInvoice(sessionRequest, { amountSat: 1000 });
      assert.equal(liveInvoice.kind, 'bolt11');
      const livePayment = JSON.parse(
        await docker(
          'lnd-peer',
          'lncli',
          '--network=regtest',
          'payinvoice',
          '--force',
          '--json',
          liveInvoice.pr
        )
      );
      assert.equal(livePayment.status, 'SUCCEEDED');
      await until(
        async () =>
          (await onlineReceiver.swapClient.swaps()).some(
            (swap) => swap.id === liveReceive.id && swap.outcome === 'claimed'
          ),
        'interactive LNURL claim'
      );
      await until(
        async () => (await onlineReceiver.getBalance()) === liveBefore + liveReceive.take.amount,
        'interactive LNURL credit'
      );
      assert.equal(
        createHash('sha256').update(Buffer.from(livePayment.payment_preimage, 'hex')).digest('hex'),
        liveReceive.lock.hash
      );
      await session.reportSettled(livePayment.payment_preimage);
      const verified = await payer.pollVerify(liveInvoice.verify, {
        expect: liveInvoice,
        timeoutMs: 10000,
      });
      assert.equal(verified.kind, 'bolt11');
      assert.equal(verified.settled, true);
      assert.equal(verified.preimage, livePayment.payment_preimage);
      report('lnurl-interactive-session', {
        sessionId: session.sessionId,
        invoiceSats: 1000,
        receivedSats: liveReceive.take.amount,
      });
    } finally {
      session.close();
      assert.equal(session.closed, true);
    }
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    const disposed = await Promise.allSettled([
      sender.manager.dispose(),
      receiver.manager.dispose(),
    ]);
    closeSharedNostrPool();
    sender.database.close();
    receiver.database.close();
    for (const result of disposed) assert.equal(result.status, 'fulfilled', result.reason?.message);
  }
});

function localWallet(path, seed) {
  seed = Uint8Array.from(seed);
  const database = new DatabaseSync(path);
  database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');
  database.exec(
    'CREATE TABLE IF NOT EXISTS lnurl_payments (key TEXT PRIMARY KEY, record TEXT NOT NULL); CREATE TABLE IF NOT EXISTS lnurl_cursors (base TEXT, address TEXT, since INTEGER, PRIMARY KEY (base, address))'
  );
  const payments = createLnurlPaymentRepository(
    {
      read: async () =>
        database
          .prepare('SELECT record FROM lnurl_payments')
          .all()
          .map((row) => JSON.parse(row.record)),
      write: async (records) => {
        for (const record of records)
          database
            .prepare('INSERT OR REPLACE INTO lnurl_payments VALUES (?, ?)')
            .run(record.key, JSON.stringify(record));
      },
      clear: async () => {
        database.exec('DELETE FROM lnurl_payments');
      },
    },
    {
      read: async (base, address) =>
        database
          .prepare('SELECT since FROM lnurl_cursors WHERE base = ? AND address = ?')
          .get(base, address)?.since,
      write: async (base, address, since) => {
        database
          .prepare('INSERT OR REPLACE INTO lnurl_cursors VALUES (?, ?, ?)')
          .run(base, address, since);
      },
      clear: async () => {
        database.exec('DELETE FROM lnurl_cursors');
      },
    }
  );
  const executor = {
    run: async (sql, params = []) => {
      database.prepare(sql).run(...params);
    },
    get: async (sql, params = []) => database.prepare(sql).get(...params),
    all: async (sql, params = []) => database.prepare(sql).all(...params),
  };
  const reopen = () =>
    new WalletManagerArkade(seed.slice(), {
      arkServerUrl: operatorUrl,
      onchainProvider: new EsploraProvider(esploraUrl),
      emulator: new RestEmulatorProvider(emulatorUrl),
      transactionMaxFee: 20000n,
      settlementConfig: false,
      solver: (path) => ({
        repository: new SQLiteAssetSwapRepository(executor, {
          prefix: `swap_${path.replace(/[^a-zA-Z0-9]/g, '_')}_`,
        }),
        discovery: { registryUrl },
      }),
      lnurl: { baseUrl: lnurlUrl, domain: new URL(lnurlUrl).hostname, store: payments },
      storage: {
        walletRepository: new SQLiteWalletRepository(executor, {
          walletStateTransactions: true,
          persistentWalletState: true,
        }),
        contractRepository: new SQLiteContractRepository(executor),
        intentRepository: new SQLiteIntentRepository(executor),
      },
    });
  return { database, manager: reopen(), reopen, payments };
}

async function docker(name, ...args) {
  const { stdout } = await run('docker', ['exec', `${prefix}${name}`, ...args], {
    timeout: 120000,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

async function faucet(address, amount) {
  await docker(
    'bitcoin',
    'bitcoin-cli',
    '-regtest',
    '-rpcuser=admin1',
    '-rpcpassword=123',
    '-rpcwallet=default',
    'sendtoaddress',
    address,
    amount
  );
  const miningAddress = (
    await docker(
      'bitcoin',
      'bitcoin-cli',
      '-regtest',
      '-rpcuser=admin1',
      '-rpcpassword=123',
      '-rpcwallet=default',
      'getnewaddress'
    )
  ).trim();
  await docker(
    'bitcoin',
    'bitcoin-cli',
    '-regtest',
    '-rpcuser=admin1',
    '-rpcpassword=123',
    '-rpcwallet=default',
    'generatetoaddress',
    '1',
    miningAddress
  );
}

async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  assert.equal(response.ok, true, `${response.status} ${url}`);
  return response.json();
}

async function until(check, label, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function report(step, data) {
  console.log(
    JSON.stringify({ step, ...data }, (_, value) =>
      typeof value === 'bigint' ? value.toString() : value
    )
  );
}
