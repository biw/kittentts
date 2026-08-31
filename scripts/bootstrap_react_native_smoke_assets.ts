import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadNodeKittenTtsRepoAssets } from "../src/node/repo-assets.js";
import { KITTENTTS_MODELS } from "../src/sdk/model-registry.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = path.resolve(REPO_ROOT, ".context", "native-smoke-assets");
const ESPEAK_REVISION = "59eb19938f12e30881c81d86ce4a7de25414c9f4";
const model = KITTENTTS_MODELS["nano-int8"];

const PHONEMIZER_ASSETS = [
  {
    filename: "en_rules",
    url: `https://raw.githubusercontent.com/espeak-ng/espeak-ng/${ESPEAK_REVISION}/dictsource/en_rules`,
    sha256: "8e75e9341ea735cc514b29a7d3a95c6c241c1cc176ad43e5699b8f7f66ab3194",
  },
  {
    filename: "en_list",
    url: `https://raw.githubusercontent.com/espeak-ng/espeak-ng/${ESPEAK_REVISION}/dictsource/en_list`,
    sha256: "24eb79018ed6253c10682096de672ce9265c1fe15c3e19e7f754d57a0fcd9790",
  },
] as const;

async function sha256(filePath: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function verify(filePath: string, expected: string): Promise<boolean> {
  try {
    return await sha256(filePath) === expected;
  } catch {
    return false;
  }
}

async function copyVerified(source: string, destination: string, expected: string): Promise<void> {
  if (await verify(destination, expected)) return;
  await fs.copyFile(source, destination);
  const actual = await sha256(destination);
  if (actual !== expected) {
    throw new Error(`integrity mismatch for ${path.basename(destination)}: expected ${expected}, got ${actual}`);
  }
}

async function downloadVerified(url: string, destination: string, expected: string): Promise<void> {
  if (await verify(destination, expected)) return;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to download ${url}: HTTP ${response.status}`);
  const temporary = `${destination}.${process.pid}.download`;
  try {
    await fs.writeFile(temporary, new Uint8Array(await response.arrayBuffer()));
    const actual = await sha256(temporary);
    if (actual !== expected) {
      throw new Error(`integrity mismatch for ${path.basename(destination)}: expected ${expected}, got ${actual}`);
    }
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function main(): Promise<void> {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const downloaded = await downloadNodeKittenTtsRepoAssets({
    repoId: model.repoId,
    revision: model.revision,
    cacheDir: process.env.KITTENTTS_CACHE_DIR,
    integrity: {
      "config.json": model.configSha256,
      [model.modelFilename]: model.modelSha256,
      [model.voicesFilename]: model.voicesSha256,
    },
  });

  await Promise.all([
    copyVerified(downloaded.configPath, path.join(OUTPUT_DIR, "config.json"), model.configSha256),
    copyVerified(downloaded.modelPath, path.join(OUTPUT_DIR, model.modelFilename), model.modelSha256),
    copyVerified(downloaded.voicesPath, path.join(OUTPUT_DIR, model.voicesFilename), model.voicesSha256),
    ...PHONEMIZER_ASSETS.map(asset =>
      downloadVerified(asset.url, path.join(OUTPUT_DIR, asset.filename), asset.sha256),
    ),
  ]);

  const files = await Promise.all(
    ["config.json", model.modelFilename, model.voicesFilename, ...PHONEMIZER_ASSETS.map(asset => asset.filename)]
      .map(async filename => {
        const filePath = path.join(OUTPUT_DIR, filename);
        return { filename, bytes: (await fs.stat(filePath)).size, sha256: await sha256(filePath) };
      }),
  );
  await fs.writeFile(
    path.join(OUTPUT_DIR, "manifest.json"),
    `${JSON.stringify({ model: model.id, repoId: model.repoId, revision: model.revision, files }, null, 2)}\n`,
  );
  console.log(JSON.stringify({ status: "pass", outputDir: OUTPUT_DIR, files }, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
