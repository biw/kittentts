import fs from "node:fs/promises";
import path from "node:path";
import { KittenTTS } from "@biwills/kittentts";

const args = process.argv.slice(2);
let repoId;
let repoBaseUrl;
let cacheDir;
const positional = [];

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--repo") {
    repoId = args[index + 1];
    index += 1;
    continue;
  }
  if (arg === "--repo-base-url") {
    repoBaseUrl = args[index + 1];
    index += 1;
    continue;
  }
  if (arg === "--cache-dir") {
    cacheDir = args[index + 1];
    index += 1;
    continue;
  }
  positional.push(arg);
}

const [textArg, voiceArg, outputArg] = positional;
const text = textArg ?? "Kitten TTS now runs from the shared Node runtime.";
const voice = voiceArg ?? "Bruno";
const outputPath = path.resolve(outputArg ?? ".context/examples/node-example.wav");

const runtime = repoId
  ? await KittenTTS.create({
      repoId,
      repoBaseUrl,
      cacheDir,
    })
  : await KittenTTS.create({ manifestPath: path.resolve(".context/reference-fixtures/manifest.json") });

try {
  const result = await runtime.generate(text, {
    voice,
    cleanText: true,
  });
  const wavBytes = result.wavData();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, wavBytes);
  console.log(
    JSON.stringify(
      {
        outputPath,
        sampleRate: result.sampleRate,
        executionProviders: result.executionProviders,
        capabilities: runtime.capabilities(),
        cleanedText: result.cleanedText,
        chunks: result.chunks.length,
      },
      null,
      2,
    ),
  );
} finally {
  await runtime.release();
}
