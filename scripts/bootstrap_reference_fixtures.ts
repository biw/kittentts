import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadNodeKittenTtsRepoAssets } from "../src/node/repo-assets.js";
import type { FixtureManifest } from "../src/core/phoneme-feeds.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_MANIFEST_PATH = path.resolve(REPO_ROOT, "fixtures", "reference-manifest.json");
const OUTPUT_DIR = path.resolve(REPO_ROOT, ".context", "reference-fixtures");

function parseArgs(argv: string[]): { force: boolean; outputDir: string } {
  let force = false;
  let outputDir = OUTPUT_DIR;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--output-dir") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--output-dir requires a value");
      }
      outputDir = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument '${arg}'`);
  }
  return { force, outputDir };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureCopied(sourcePath: string, targetPath: string, force: boolean): Promise<void> {
  if (!force && (await fileExists(targetPath))) {
    return;
  }
  await fs.copyFile(sourcePath, targetPath);
}

async function main() {
  const { force, outputDir } = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(await fs.readFile(SOURCE_MANIFEST_PATH, "utf8")) as FixtureManifest;
  const downloaded = await downloadNodeKittenTtsRepoAssets({
    repoId: manifest.model,
    revision: manifest.revision,
    repoBaseUrl: process.env.KITTENTTS_REPO_BASE_URL,
    cacheDir: process.env.KITTENTTS_CACHE_DIR,
  });

  await fs.mkdir(outputDir, { recursive: true });
  const modelOutputPath = path.resolve(outputDir, manifest.model_asset_path);
  const voicesAssetPath = manifest.voices_asset_path ?? "voices.npz";
  const voicesOutputPath = path.resolve(outputDir, voicesAssetPath);

  await ensureCopied(downloaded.modelPath, modelOutputPath, force);
  await ensureCopied(downloaded.voicesPath, voicesOutputPath, force);

  const materializedManifest: FixtureManifest = {
    ...manifest,
    model_path: downloaded.modelPath,
    model_asset_path: path.relative(outputDir, modelOutputPath),
    voices_asset_path: path.relative(outputDir, voicesOutputPath),
  };
  const manifestOutputPath = path.resolve(outputDir, "manifest.json");
  await fs.writeFile(manifestOutputPath, `${JSON.stringify(materializedManifest, null, 2)}\n`);

  console.log(
    JSON.stringify(
      {
        status: "pass",
        outputDir,
        manifestPath: manifestOutputPath,
        modelPath: modelOutputPath,
        voicesPath: voicesOutputPath,
        repoId: downloaded.repoId,
        revision: downloaded.revision,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
