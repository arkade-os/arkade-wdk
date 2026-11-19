import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { authenticateAsync } from 'expo-local-authentication';
import {
  createSecureStorage,
  WdkAppProvider,
  useModule,
  useWalletManager,
  useWdkApp,
  type WdkConfigs,
} from '@tetherto/wdk-react-native-core';

const walletId = 'arkade-core-regtest-wallet-v1';
const secureStorage = createSecureStorage();
const worklet = { bundle: require('../.wdk-mobile/wdk-worklet.bundle.js') as string };
const wdkConfigs = {
  networks: { bitcoin: { blockchain: 'bitcoin', config: { network: 'regtest' } } },
  modules: {
    arkade: {
      arkServerUrl: 'http://127.0.0.1:57020',
      esploraUrl: 'http://127.0.0.1:57000/api',
    },
  },
} satisfies WdkConfigs;

type ArkadeApi = {
  getAddress(): Promise<string>;
  getBalanceDetails(): Promise<{ total: number; boarding: { total: number } }>;
  close(): Promise<null>;
};

type Snapshot = { address: string; balance: Awaited<ReturnType<ArkadeApi['getBalanceDetails']>> };

function useAction() {
  const active = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = useCallback(async (failure: string, action: () => Promise<void>) => {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch {
      setError(failure);
    } finally {
      active.current = false;
      setBusy(false);
    }
  }, []);
  return { busy, error, run };
}

async function authenticate(promptMessage: string) {
  const result = await authenticateAsync({ promptMessage, cancelLabel: 'Cancel' });
  if (result.success) return true;
  if (['user_cancel', 'app_cancel', 'system_cancel'].includes(result.error)) return false;
  throw new Error('Device authentication failed');
}

function Action({
  label,
  disabled,
  onPress,
  secondary = false,
}: {
  label: string;
  disabled: boolean;
  onPress: () => void;
  secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.secondaryButton,
        (pressed || disabled) && styles.dimmed,
      ]}
    >
      <Text style={styles.buttonLabel}>{label}</Text>
    </Pressable>
  );
}

function ErrorText({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <Text accessibilityRole="alert" style={styles.error}>
      {message}
    </Text>
  );
}

function Wallet({ lock }: { lock: () => Promise<void> }) {
  const arkade = useModule<ArkadeApi>('arkade');
  const { busy, error, run } = useAction();
  const sealed = useRef(false);
  const [closed, setClosed] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot>();

  const refresh = useCallback(() => {
    if (sealed.current) return;
    void run(
      'Could not read the wallet. Check the local regtest services and refresh.',
      async () => {
        const [address, balance] = await Promise.all([
          arkade.getAddress(),
          arkade.getBalanceDetails(),
        ]);
        if (!address.startsWith('tark1')) throw new Error('Expected a regtest Arkade address');
        setSnapshot({ address, balance });
      }
    );
  }, [arkade, run]);

  useEffect(refresh, [refresh]);

  const lockWallet = () => {
    void run('Could not lock the wallet. Try again.', async () => {
      if (!sealed.current) {
        await arkade.close();
        sealed.current = true;
        setClosed(true);
        setSnapshot(undefined);
      }
      await lock();
    });
  };

  return (
    <>
      <View style={styles.card}>
        <Text style={styles.label}>Total balance</Text>
        <Text style={styles.balance} testID="wallet-total">
          {snapshot ? `${snapshot.balance.total} sats` : '—'}
        </Text>
        <Text style={styles.muted} testID="wallet-boarding">
          {snapshot
            ? `${snapshot.balance.boarding.total} sats boarding`
            : 'Boarding balance unavailable'}
        </Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.label}>Arkade receive address</Text>
        <Text selectable style={styles.address} testID="wallet-address">
          {snapshot?.address ?? 'Address unavailable'}
        </Text>
      </View>
      {busy && (
        <ActivityIndicator
          color={colors.accent}
          accessibilityLabel="Wallet operation in progress"
        />
      )}
      <ErrorText message={error} />
      <Action label="Refresh balance" secondary disabled={busy || closed} onPress={refresh} />
      <Action label="Lock wallet" disabled={busy} onPress={lockWallet} />
    </>
  );
}

function WalletScreen() {
  const { state } = useWdkApp();
  const { wallets, lock, unlock, createWallet } = useWalletManager();
  const { busy, error, run } = useAction();
  const saved = wallets.some((wallet) => wallet.identifier === walletId && wallet.exists);
  const ready = state.status === 'READY' && state.walletId === walletId;
  const canOpen =
    state.status === 'LOCKED' || state.status === 'NO_WALLET' || state.status === 'ERROR';

  const openWallet = () => {
    void run('Could not open the wallet. Check device authentication and try again.', async () => {
      if (
        !(await authenticate(saved ? 'Unlock the regtest wallet' : 'Create the regtest wallet'))
      ) {
        return;
      }
      if (saved || (await secureStorage.hasWallet(walletId))) await unlock(walletId);
      else await createWallet(walletId);
    });
  };

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.eyebrow}>ARKADE · REGTEST</Text>
          <Text accessibilityRole="header" style={styles.title}>
            Local wallet
          </Text>
          <Text style={styles.muted}>Read balances and receive test sats on this device.</Text>
        </View>
        {ready ? (
          <Wallet key={state.walletId} lock={lock} />
        ) : (
          <View style={styles.card}>
            <Text style={styles.label}>
              {canOpen ? (saved ? 'Wallet locked' : 'No regtest wallet') : 'Starting the worklet…'}
            </Text>
            {(busy || !canOpen) && <ActivityIndicator color={colors.accent} />}
            <ErrorText
              message={
                error ??
                (state.status === 'ERROR' ? 'The wallet worklet reported an error.' : undefined)
              }
            />
            {canOpen && (
              <Action
                label={saved ? 'Unlock wallet' : 'Create regtest wallet'}
                disabled={busy}
                onPress={openWallet}
              />
            )}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <WdkAppProvider bundle={worklet} wdkConfigs={wdkConfigs}>
        <WalletScreen />
      </WdkAppProvider>
    </SafeAreaProvider>
  );
}

const colors = { background: '#111D1A', card: '#1C2B26', text: '#F0FAF4', accent: '#AAF1C7' };
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: 24, gap: 16, maxWidth: 560, width: '100%', alignSelf: 'center' },
  header: { paddingVertical: 16, gap: 8 },
  eyebrow: { color: colors.accent, fontSize: 12, letterSpacing: 1.5, fontWeight: '700' },
  title: { color: colors.text, fontSize: 34, fontWeight: '700' },
  muted: { color: '#B8CFC3', fontSize: 15, lineHeight: 22 },
  card: { backgroundColor: colors.card, borderRadius: 16, padding: 18, gap: 10 },
  label: { color: colors.text, fontSize: 16, fontWeight: '600' },
  balance: { color: colors.text, fontSize: 36, fontWeight: '700', fontVariant: ['tabular-nums'] },
  address: { color: colors.text, fontFamily: 'monospace', fontSize: 14, lineHeight: 22 },
  button: { backgroundColor: colors.accent, borderRadius: 12, padding: 14, alignItems: 'center' },
  secondaryButton: { backgroundColor: '#D0E3D9' },
  buttonLabel: { color: colors.background, fontSize: 16, fontWeight: '600' },
  dimmed: { opacity: 0.6 },
  error: { color: '#FFC2B9', fontSize: 15, lineHeight: 22 },
});
