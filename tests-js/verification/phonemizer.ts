import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { phonemize as phonemizeJs } from "phonemizer";
import type { FixtureManifest } from "../../src/core/phoneme-feeds.js";
import {
  normalizePhonemizerJsOutput,
  PhonemizerJsPhonemizer,
  phonemizeWithPreservedPunctuation,
  reconstructPreservedPunctuation,
} from "../../src/core/phonemizer.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = path.join(repoRoot, ".context", "reference-fixtures", "manifest.json");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export async function verifyPhonemizerParity(): Promise<void> {
  const started = performance.now();
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as FixtureManifest;
  const phonemizer = new PhonemizerJsPhonemizer();
  const mismatches: Array<Record<string, unknown>> = [];

  let rawExact = 0;
  let adaptedExact = 0;
  let totalChunks = 0;

  for (const fixtureCase of manifest.cases) {
    for (const chunk of fixtureCase.chunks) {
      totalChunks += 1;
      const rawParts = await phonemizeJs(chunk.text, "en-us");
      let rawRebuilt: string | null = null;
      try {
        rawRebuilt = reconstructPreservedPunctuation(chunk.text, rawParts);
      } catch {
        // Some abbreviations are not split by the npm package's whole-string API.
      }
      const rebuilt = await phonemizeWithPreservedPunctuation(chunk.text, "en-us", phonemizeJs);
      const adapted = normalizePhonemizerJsOutput(rebuilt);
      const fromAdapter = await phonemizer.phonemize(chunk.text);

      assert(
        fromAdapter === adapted,
        `adapter output drifted for ${fixtureCase.id} chunk ${chunk.index}`,
      );

      if (rawRebuilt === chunk.phonemes_raw) {
        rawExact += 1;
      }
      if (adapted === chunk.phonemes_raw) {
        adaptedExact += 1;
      } else {
        mismatches.push({
          caseId: fixtureCase.id,
          chunkIndex: chunk.index,
          text: chunk.text,
          expected: chunk.phonemes_raw,
          raw: rebuilt,
          adapted,
        });
      }
    }
  }

  assert(mismatches.length === 0, JSON.stringify(mismatches, null, 2));

  console.log(
    JSON.stringify(
      {
        totalChunks,
        rawExact,
        adaptedExact,
        elapsedMs: Math.round(performance.now() - started),
      },
      null,
      2,
    ),
  );
}
