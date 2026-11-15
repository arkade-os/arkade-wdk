/**
 * Arkade-specific types for Bitcoin wallet with Arkade support
 *
 * For WDK types, import directly from:
 * - @tetherto/wdk
 * - @tetherto/wdk-wallet
 */

/**
 * @typedef {Omit<import('@arkade-os/swap').SwapClientConfig, 'wallet' | 'repository'> & {
 *   repository: import('@arkade-os/swap').AssetSwapRepository
 * }} SolverConfig
 */

/**
 * @typedef {import('@tetherto/wdk-wallet').WalletConfig &
 *   Omit<import('@arkade-os/sdk').WalletConfig, 'identity'> & {
 *     arkServerUrl?: string,
 *     solver?: (path: string) => SolverConfig,
 *     lnurl?: import('@arkade-os/lnurl-client/arkade').ArkadeLnurlConfig
 *   }} ArkadeWalletConfig
 */

export default {};
