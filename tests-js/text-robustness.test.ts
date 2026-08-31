import assert from "node:assert/strict";
import { test } from "vitest";
import {
  TextPreprocessor,
  chunkText,
  normalizeUnicode,
  numberToWords,
  preprocessForTts,
} from "../src/core/text-preprocess.js";

const multilingualSamples = [
  "Café déjà vu in São Paulo.",
  "naïve façade and piñata",
  "Καλημέρα κόσμε.",
  "Привет, мир!",
  "مرحبا بالعالم.",
  "नमस्ते दुनिया।",
  "こんにちは世界。",
  "你好，世界。",
  "안녕하세요 세계.",
  "שלום עולם.",
  "สวัสดีชาวโลก",
  "Xin chào thế giới.",
  "Ahoj světe.",
  "Dzień dobry świecie.",
  "Merhaba dünya.",
] as const;

function hasUnpairedSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

test("normalization sanitizes malformed UTF-16 without discarding valid Unicode", () => {
  assert.equal(normalizeUnicode("Cafe\u0301"), "Café");
  assert.equal(normalizeUnicode("before\ud800after\udc00"), "before after ");
  assert.equal(preprocessForTts("Bad\ud800 input \udc00 remains usable."), "bad input remains usable.");
  assert.equal(hasUnpairedSurrogate(preprocessForTts("x\ud800y")), false);

  for (const sample of multilingualSamples) {
    const normalized = preprocessForTts(sample);
    assert.ok(normalized.length > 0, sample);
    assert.equal(hasUnpairedSurrogate(normalized), false, sample);
  }
});

test("emoji and supplementary characters remain well-formed", () => {
  const input = "Hello 👋 world 🌍! Family: 👨‍👩‍👧‍👦.";
  const normalized = preprocessForTts(input);
  assert.equal(normalized, "hello 👋 world 🌍! family: 👨‍👩‍👧‍👦.");
  assert.equal(hasUnpairedSurrogate(normalized), false);
});

test("number normalization preserves punctuation and rejects unsafe values", () => {
  assert.equal(preprocessForTts("Café, naïve, and coöperate."), "café, naïve, and coöperate.");
  assert.equal(numberToWords(999_999_999_999_999), "nine hundred ninety-nine trillion nine hundred ninety-nine billion nine hundred ninety-nine million nine hundred ninety-nine thousand nine hundred ninety-nine");
  assert.throws(() => numberToWords(Number.NaN), /safe integer/);
  assert.throws(() => numberToWords(Number.POSITIVE_INFINITY), /safe integer/);
  assert.throws(() => numberToWords(Number.MAX_SAFE_INTEGER), /safe integer/);
});

test("chunking enforces its bound for long words and large documents", () => {
  const longWord = "x".repeat(1_003);
  const document = Array.from(
    { length: 1_000 },
    (_, index) => `Sentence ${index} contains ${index % 11} values and ${longWord}.`,
  ).join(" ");
  const chunks = chunkText(document, 128);

  assert.ok(chunks.length > 1_000);
  assert.ok(chunks.every((chunk) => chunk.length >= 2 && chunk.length <= 128));
  assert.ok(chunks.every((chunk) => /[.!?,;:]$/.test(chunk)));
  assert.deepEqual(chunkText(document, 128), chunks);
  assert.throws(() => chunkText("text", 1), /maxLen/);
  assert.throws(() => chunkText("text", 2.5), /maxLen/);
});

test("preprocessing and chunking satisfy deterministic fuzz invariants", () => {
  let state = 0x6d2b79f5;
  const random = () => {
    state = Math.imul(state ^ (state >>> 15), state | 1);
    state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
    return ((state ^ (state >>> 14)) >>> 0) / 4_294_967_296;
  };
  const alphabet = [
    ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    " ", "\t", "\n", ".", ",", "!", "?", ";", ":", "-", "—", "…",
    "é", "ø", "ß", "中", "界", "👋", "🌍",
  ];
  const preprocessor = new TextPreprocessor({ removePunctuation: false });

  for (let caseIndex = 0; caseIndex < 500; caseIndex += 1) {
    const length = 1 + Math.floor(random() * 600);
    let input = "";
    for (let index = 0; index < length; index += 1) {
      input += alphabet[Math.floor(random() * alphabet.length)];
    }
    if (caseIndex % 17 === 0) input += "\ud800";
    if (caseIndex % 29 === 0) input = `\udc00${input}`;

    const normalized = preprocessor.process(input);
    assert.equal(preprocessor.process(input), normalized);
    assert.equal(hasUnpairedSurrogate(normalized), false);
    assert.equal(normalized, normalized.trim());
    assert.doesNotMatch(normalized, /\s{2,}/);

    const chunks = chunkText(normalized, 80);
    assert.deepEqual(chunkText(normalized, 80), chunks);
    assert.ok(chunks.every((chunk) => chunk.length <= 80));
    assert.ok(chunks.every((chunk) => /[.!?,;:]$/.test(chunk)));
  }
});
