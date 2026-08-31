import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { KITTENTTS_MODELS } from "../src/sdk/model-registry.js";
import { run, runPnpm } from "./helpers/process.js";

const PACKAGE_BUDGETS = {
  tarballBytes: 1_350_000,
  unpackedBytes: 4_100_000,
  files: 52,
  emittedJavaScriptBytes: 3_950_000,
  largestModelDownloadBytes: 82_000_000,
  nanoInt8DownloadBytes: 28_000_000,
} as const;

const requiredPackFiles = [
  "dist/audio/index.d.ts",
  "dist/audio/index.js",
  "dist/audio/mp3.d.ts",
  "dist/audio/mp3.js",
  "dist/browser/index.d.ts",
  "dist/browser/index.js",
  "dist/browser/worker.d.ts",
  "dist/browser/worker.js",
  "dist/node/index.d.ts",
  "dist/node/index.js",
  "dist/react-native/index.d.ts",
  "dist/react-native/index.js",
  "dist/sdk/browser-entry.d.ts",
  "dist/sdk/browser-entry.js",
  "dist/sdk/index.d.ts",
  "dist/sdk/node-entry.d.ts",
  "dist/sdk/node-entry.js",
  "dist/sdk/react-native-entry.d.ts",
  "dist/sdk/react-native-entry.js",
  "dist/sdk/react-native-web-entry.d.ts",
  "dist/sdk/react-native-web-entry.js",
  "package.json",
  "README.md",
  "LICENSE",
  "docs/javascript-sdk.md",
  "docs/phonemizer-bakeoff.md",
  "docs/react-native.md",
] as const;

interface PackManifest {
  size: number;
  unpackedSize: number;
  entryCount: number;
  files: Array<{ path: string; size: number }>;
}

function parsePackManifest(output: string): PackManifest {
  const parsed = JSON.parse(output) as unknown;
  const candidates = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && "files" in parsed
      ? [parsed]
      : parsed && typeof parsed === "object"
        ? Object.values(parsed)
        : [];
  const manifest = candidates.length === 1 ? candidates[0] : undefined;
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !("files" in manifest) ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error(`unexpected npm pack output: ${output}`);
  }
  return manifest as PackManifest;
}

test("published package contents and emitted JavaScript stay within budgets", async () => {
  const output = await run("npm", ["pack", "--json", "--dry-run", "--ignore-scripts"], {
    captureStdout: true,
  });
  const manifest = parsePackManifest(output);
  const packedFiles = new Set(manifest.files.map((file) => file.path));
  expect(requiredPackFiles.filter((file) => !packedFiles.has(file))).toEqual([]);
  expect(manifest.size).toBeLessThanOrEqual(PACKAGE_BUDGETS.tarballBytes);
  expect(manifest.unpackedSize).toBeLessThanOrEqual(PACKAGE_BUDGETS.unpackedBytes);
  expect(manifest.entryCount).toBeLessThanOrEqual(PACKAGE_BUDGETS.files);

  const emittedJavaScriptBytes = manifest.files
    .filter((file) => file.path.startsWith("dist/") && file.path.endsWith(".js"))
    .reduce((total, file) => total + file.size, 0);
  expect(emittedJavaScriptBytes).toBeLessThanOrEqual(PACKAGE_BUDGETS.emittedJavaScriptBytes);

  const emittedJavaScript = manifest.files.filter(
    (file) => file.path.startsWith("dist/") && file.path.endsWith(".js"),
  );
  for (const file of emittedJavaScript) {
    const source = await fs.readFile(path.resolve(file.path), "utf8");
    const relativeReferences = [
      ...source.matchAll(/(?:from\s+|import\()\s*["'](\.\.?\/[^"']+)["']/g),
      ...source.matchAll(/new URL\(["'](\.\.?\/[^"']+)["'],\s*import\.meta\.url\)/g),
    ];
    for (const match of relativeReferences) {
      const target = path.resolve(path.dirname(file.path), match[1]);
      await expect(fs.stat(target), `${file.path} imports missing ${match[1]}`).resolves.toBeDefined();
    }
  }
});

test("runtime peers and model downloads stay explicit and bounded", async () => {
  const packageJson = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8")) as {
    name?: string;
    dependencies?: Record<string, string>;
    exports: Record<string, unknown>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    sideEffects?: string[];
  };
  expect(packageJson.name).toBe("@biwills/kittentts");
  expect(packageJson.dependencies).toBeUndefined();
  expect(packageJson.sideEffects).toEqual(["./dist/browser/worker.js"]);
  expect(packageJson.peerDependencies).toEqual({
    "@dr.pogodin/react-native-fs": "2.40.1",
    "onnxruntime-node": "1.27.0",
    "onnxruntime-react-native": "1.24.3",
    "onnxruntime-web": "1.27.0",
  });
  expect(packageJson.peerDependenciesMeta).toEqual({
    "@dr.pogodin/react-native-fs": { optional: true },
    "onnxruntime-node": { optional: true },
    "onnxruntime-react-native": { optional: true },
    "onnxruntime-web": { optional: true },
  });

  const rootConditions = Object.keys(packageJson.exports["."] as Record<string, unknown>);
  expect(rootConditions.indexOf("browser")).toBeLessThan(rootConditions.indexOf("react-native"));
  expect(rootConditions.indexOf("react-native")).toBeLessThan(rootConditions.indexOf("node"));
  const reactNativeConditions = packageJson.exports["./react-native"] as Record<string, unknown>;
  expect(reactNativeConditions).toMatchObject({
    browser: {
      types: "./dist/sdk/react-native-web-entry.d.ts",
      import: "./dist/sdk/react-native-web-entry.js",
    },
    "react-native": {
      types: "./dist/sdk/react-native-entry.d.ts",
      import: "./dist/sdk/react-native-entry.js",
    },
    types: "./dist/sdk/react-native-entry.d.ts",
    import: "./dist/sdk/react-native-entry.js",
  });

  for (const model of Object.values(KITTENTTS_MODELS)) {
    expect(model.modelBytes + model.voicesBytes).toBeLessThanOrEqual(PACKAGE_BUDGETS.largestModelDownloadBytes);
  }
  const nanoInt8 = KITTENTTS_MODELS["nano-int8"];
  expect(nanoInt8.modelBytes + nanoInt8.voicesBytes).toBeLessThanOrEqual(
    PACKAGE_BUDGETS.nanoInt8DownloadBytes,
  );
});

test("React Native output keeps native peers external and excludes browser-only phonemizer APIs", async () => {
  const entryPath = path.resolve("dist/sdk/react-native-entry.js");
  const entry = await fs.readFile(entryPath, "utf8");
  const relativeImports = [...entry.matchAll(/from\s*["'](\.\.?\/[^"']+)["']/g)];
  const importedSources = await Promise.all(relativeImports.map(async (match) => (
    fs.readFile(path.resolve(path.dirname(entryPath), match[1]), "utf8")
  )));
  const nativeOutput = [entry, ...importedSources].join("\n");
  expect(nativeOutput).toContain("onnxruntime-react-native");
  expect(nativeOutput).toContain("@dr.pogodin/react-native-fs");
  expect(nativeOutput).not.toContain("onnxruntime-node");
  expect(nativeOutput).not.toContain("onnxruntime-web");
  expect(nativeOutput).not.toContain("DecompressionStream");
});

test("package metadata and declarations pass publint and ATTW", async () => {
  await runPnpm(["exec", "publint", "--strict"]);
  await runPnpm(["exec", "attw", "--pack", ".", "--profile", "esm-only"]);
});

test("npm publication dry run succeeds", async () => {
  await run("npm", ["publish", "--dry-run", "--ignore-scripts", "--tag", "latest"]);
});
