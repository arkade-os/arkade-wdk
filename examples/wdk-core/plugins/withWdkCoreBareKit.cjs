const { existsSync, readFileSync, readdirSync, statSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const {
  withAppBuildGradle,
  withDangerousMod,
  withGradleProperties,
  withProjectBuildGradle,
} = require('expo/config-plugins');

const addons = '.wdk-mobile/addons/android';
const runtime = 'com.github.holepunchto.bare-kit-kotlin:bare-kit-kotlin-android:v0.2.6@aar';
const repository = 'https://www.jitpack.io';
const androidAbis = ['arm64-v8a', 'x86_64'];
const gradle = '8.14.3';
const gradleChecksum = 'bd71102213493060956ec229d946beee57158dbd89d0e62b91bca0fa2c5f3531';

function insert(source, block, snippet) {
  if (source.includes(snippet)) return source;
  if (!block.test(source)) throw new Error(`Cannot find Android Gradle block: ${block}`);
  return source.replace(block, (start) => `${start}\n    ${snippet}`);
}

module.exports = function withWdkCoreBareKit(config) {
  config = withDangerousMod(config, [
    'android',
    (config) => {
      for (const abi of androidAbis) {
        const directory = join(config.modRequest.projectRoot, addons, abi);
        const libraries = existsSync(directory)
          ? readdirSync(directory).filter((name) => name.endsWith('.so'))
          : [];
        if (!libraries.length || libraries.some((name) => !statSync(join(directory, name)).size)) {
          throw new Error(
            'Link the Android worklet addons first: npm run bundle:mobile -- android'
          );
        }
      }
      // Gradle 8.14.3 keeps the SDK 56 Kotlin plugins compatible on Windows.
      const wrapper = join(
        config.modRequest.platformProjectRoot,
        'gradle/wrapper/gradle-wrapper.properties'
      );
      const properties = readFileSync(wrapper, 'utf8');
      if (!/^distributionUrl=.+\/gradle-(9\.3\.1|8\.14\.3)-bin\.zip$/m.test(properties)) {
        throw new Error('Expected the pinned Expo 56 Gradle wrapper');
      }
      const pinned = properties
        .replace(
          /^distributionUrl=.+$/m,
          `distributionUrl=https\\://services.gradle.org/distributions/gradle-${gradle}-bin.zip`
        )
        .replace(/^distributionSha256Sum=.*\r?\n/m, '');
      writeFileSync(wrapper, `${pinned.trimEnd()}\ndistributionSha256Sum=${gradleChecksum}\n`);
      return config;
    },
  ]);
  config = withGradleProperties(config, (config) => {
    const architectures = config.modResults.find(
      (item) => item.type === 'property' && item.key === 'reactNativeArchitectures'
    );
    if (architectures) architectures.value = androidAbis.join(',');
    else
      config.modResults.push({
        type: 'property',
        key: 'reactNativeArchitectures',
        value: androidAbis.join(','),
      });
    const key = 'android.minSdkVersion';
    const item = config.modResults.find((item) => item.type === 'property' && item.key === key);
    if (!item) config.modResults.push({ type: 'property', key, value: '29' });
    else if (Number(item.value) < 29) item.value = '29';
    return config;
  });
  config = withProjectBuildGradle(config, (config) => {
    if (!config.modResults.contents.includes('jitpack.io')) {
      config.modResults.contents = insert(
        config.modResults.contents,
        /allprojects\s*\{\s*repositories\s*\{/,
        `maven { url '${repository}' }`
      );
    }
    return config;
  });
  return withAppBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') {
      throw new Error('The WDK example requires Expo’s Groovy Android project');
    }
    let contents = insert(
      config.modResults.contents,
      /^android\s*\{/m,
      `sourceSets.main.jniLibs.srcDir(rootProject.file('../${addons}'))`
    );
    contents = insert(
      contents,
      /^android\s*\{/m,
      `sourceSets.main.jniLibs.srcDir(layout.buildDirectory.dir('generated/wdkCoreBareKit/jni'))`
    );
    if (!contents.includes("tasks.register('extractWdkCoreBareKit'")) {
      // The React Native module dlopens the .so and needs none of the AAR's Kotlin dependencies.
      contents += `
configurations {
    wdkCoreBareKitRuntime { canBeConsumed = false; transitive = false }
}
dependencies { wdkCoreBareKitRuntime('${runtime}') }
def extractWdkCoreBareKit = tasks.register('extractWdkCoreBareKit', Sync) {
    from { zipTree(configurations.wdkCoreBareKitRuntime.singleFile) }
    include 'jni/arm64-v8a/libbare-kit.so', 'jni/x86_64/libbare-kit.so'
    into layout.buildDirectory.dir('generated/wdkCoreBareKit')
}
tasks.named('preBuild') { dependsOn extractWdkCoreBareKit }
`;
    }
    config.modResults.contents = contents;
    return config;
  });
};
