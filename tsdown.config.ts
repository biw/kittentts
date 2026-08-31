import { defineConfig, type UserConfig } from "tsdown";

const shared: UserConfig = {
  format: "esm",
  target: "es2022",
  sourcemap: false,
  dts: true,
  fixedExtension: false,
  failOnWarn: true,
  deps: {
    neverBundle: [
      /^@dr\.pogodin\/react-native-fs$/,
      /^onnxruntime-node$/,
      /^onnxruntime-react-native$/,
      /^onnxruntime-web(?:\/.*)?$/,
    ],
  },
};

const inferenceDependencies: UserConfig["deps"] = {
  ...shared.deps,
  alwaysBundle: [/^fflate$/, /^phonemizer$/, /^wasm-media-encoders$/],
  onlyBundle: [/^@swc\/helpers$/, /^fflate$/, /^phonemizer$/, /^wasm-media-encoders$/],
};

const reactNativeInferenceDependencies: UserConfig["deps"] = {
  ...shared.deps,
  alwaysBundle: [/^fflate$/, /^wasm-media-encoders$/],
  onlyBundle: [/^@swc\/helpers$/, /^fflate$/, /^wasm-media-encoders$/],
};

export default defineConfig([
  {
    ...shared,
    name: "node",
    deps: inferenceDependencies,
    clean: true,
    platform: "node",
    entry: {
      "audio/index": "src/audio/index.ts",
      "node/index": "src/node/index.ts",
      "sdk/index": "src/sdk/index.ts",
      "sdk/node-entry": "src/sdk/node-entry.ts",
    },
  },
  {
    ...shared,
    name: "browser",
    deps: inferenceDependencies,
    clean: false,
    platform: "browser",
    entry: {
      "browser/index": "src/browser/index.ts",
      "browser/worker": "src/browser/worker.ts",
      "sdk/browser-entry": "src/sdk/browser-entry.ts",
      "sdk/react-native-web-entry": "src/sdk/react-native-web-entry.ts",
    },
  },
  {
    ...shared,
    name: "react-native",
    deps: reactNativeInferenceDependencies,
    clean: false,
    minify: true,
    platform: "neutral",
    entry: {
      "react-native/index": "src/react-native/index.ts",
      "sdk/react-native-entry": "src/sdk/react-native-entry.ts",
    },
  },
  {
    ...shared,
    name: "mp3",
    deps: {
      ...shared.deps,
      alwaysBundle: [/^wasm-media-encoders$/],
      onlyBundle: [/^@swc\/helpers$/, /^wasm-media-encoders$/],
    },
    clean: false,
    platform: "neutral",
    entry: {
      "audio/mp3": "src/audio/mp3.ts",
    },
  },
]);
