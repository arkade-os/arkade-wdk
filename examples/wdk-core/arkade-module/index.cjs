const { default: WalletManagerArkade } = require('@arkade-os/wdk');
const { EsploraProvider, RestOperatorProvider } = require('@arkade-os/sdk');

function localUrl(value) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('The Arkade Core example requires a loopback regtest URL');
  }
  return url.href.replace(/\/$/, '');
}

class RegtestOperatorProvider extends RestOperatorProvider {
  async getInfo() {
    const info = await super.getInfo();
    if (info.network !== 'regtest') throw new Error('Expected an Arkade regtest operator');
    return info;
  }
}

function createModule({ seed, config = {} }) {
  if (!(seed instanceof Uint8Array) || seed.length !== 64) {
    throw new Error('Expected a 64-byte BIP39 seed');
  }
  const arkServerUrl = localUrl(config.arkServerUrl ?? 'http://127.0.0.1:57020');
  const esploraUrl = localUrl(config.esploraUrl ?? 'http://127.0.0.1:57000/api');
  // The WDK manager wipes its seed on disposal; Pear shares its own copy with other modules.
  const ownedSeed = Uint8Array.from(seed);
  let manager;
  try {
    manager = new WalletManagerArkade(ownedSeed, {
      arkServerUrl,
      operatorProvider: new RegtestOperatorProvider(arkServerUrl),
      // Bare's WebSocket lacks the DOM event methods used by Esplora.
      onchainProvider: new EsploraProvider(esploraUrl, { forcePolling: true }),
      settlementConfig: false,
    });
  } catch (error) {
    ownedSeed.fill(0);
    throw error;
  }

  return {
    async getAddress() {
      return (await manager.getAccount()).getAddress();
    },
    async getBalanceDetails() {
      return (await manager.getAccount()).getBalanceDetails();
    },
    close() {
      return manager.dispose();
    },
  };
}

module.exports = { createModule };
