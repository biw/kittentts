import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type FixtureManifest } from "../../src/core/phoneme-feeds.js";
import { chunkText, preprocessForTts } from "../../src/core/text-preprocess.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = path.join(repoRoot, ".context", "reference-fixtures", "manifest.json");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export async function verifyPreprocessingParity(): Promise<void> {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as FixtureManifest;
  let cleanedCases = 0;
  let chunkedCases = 0;

  for (const fixtureCase of manifest.cases) {
    const cleanedText = fixtureCase.clean_text ? preprocessForTts(fixtureCase.text) : fixtureCase.text;
    assert(
      cleanedText === fixtureCase.cleaned_text,
      `cleaned text mismatch for ${fixtureCase.id}\nactual:   ${cleanedText}\nexpected: ${fixtureCase.cleaned_text}`,
    );
    cleanedCases += 1;

    const expectedChunks = fixtureCase.chunks.map((chunk) => chunk.text);
    const actualChunks = chunkText(cleanedText);
    assert(
      actualChunks.length === expectedChunks.length,
      `chunk count mismatch for ${fixtureCase.id}: ${actualChunks.length} !== ${expectedChunks.length}`,
    );
    for (let index = 0; index < actualChunks.length; index += 1) {
      if (actualChunks[index] !== expectedChunks[index]) {
        throw new Error(
          `chunk mismatch for ${fixtureCase.id} at ${index}\nactual:   ${actualChunks[index]}\nexpected: ${expectedChunks[index]}`,
        );
      }
    }
    chunkedCases += 1;
  }

  console.log(
    JSON.stringify(
      {
        cleanedCases,
        chunkedCases,
      },
      null,
      2,
    ),
  );
}
