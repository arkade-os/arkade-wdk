const mobileTargets = {
  android: ['android-arm64', 'android-x64'],
  ios: ['ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator'],
};
const mobile = process.env.WDK_WORKLET_TARGET;
if (mobile && !Object.hasOwn(mobileTargets, mobile)) {
  throw new Error('WDK_WORKLET_TARGET must be android or ios');
}

module.exports = {
  networks: { bitcoin: { package: '@tetherto/wdk-wallet-btc' } },
  modules: {
    arkade: { package: '@arkade-os/wdk-core-example-module', factory: 'createModule' },
  },
  allowedMethods: { bitcoin: { methods: ['getAddress'] } },
  allowedModuleMethods: { arkade: { methods: ['getAddress', 'getBalanceDetails', 'close'] } },
  output: mobile
    ? {
        bundle: './.wdk-mobile/wdk-worklet.bundle.js',
        types: './.wdk-mobile/index.d.ts',
        addons: {
          android: './.wdk-mobile/addons/android',
          ios: './.wdk-mobile/addons/ios',
        },
        addonsYml: './.wdk-mobile/addons/ios/addons.yml',
      }
    : {
        addons: {
          windows: './.wdk-bundle/addons',
          linux: './.wdk-bundle/addons',
          macos: './.wdk-bundle/addons',
        },
      },
  options: {
    targets: mobile ? mobileTargets[mobile] : [`${process.platform}-${process.arch}`],
    linkAddons: true,
    convertEsmToCjs: mobile === 'ios',
  },
};
