import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "vitest";
import { chunkText, preprocessForTts } from "../src/core/text-preprocess.js";

interface TextParityCase {
  id: string;
  text: string;
  clean_text: boolean;
  cleaned_text: string;
  chunks: string[];
}

test("expanded text corpus matches the independent Python oracle", async () => {
  const fixture = JSON.parse(await fs.readFile("fixtures/text-parity.json", "utf8")) as {
    cases: TextParityCase[];
  };
  assert.ok(fixture.cases.length >= 35);

  for (const fixtureCase of fixture.cases) {
    const cleaned = fixtureCase.clean_text
      ? preprocessForTts(fixtureCase.text)
      : fixtureCase.text;
    assert.equal(cleaned, fixtureCase.cleaned_text, `${fixtureCase.id}: cleaned text`);
    assert.deepEqual(chunkText(cleaned), fixtureCase.chunks, `${fixtureCase.id}: chunks`);
  }
});
