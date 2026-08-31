import { phonemize as phonemizeJs } from "/node_modules/phonemizer/dist/phonemizer.js";

const PRESERVED_PUNCTUATION_RE = /[,:;.!?¡¿—…«»"“”]+/g;
const PAD = "$";
const PUNCTUATION = ';:,.!?¡¿—…"«»"" ';
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const LETTERS_IPA =
  "ɑɐɒæɓʙβɔɕçɗɖðʤəɘɚɛɜɝɞɟʄɡɠɢʛɦɧħɥʜɨɪʝɭɬɫɮʟɱɯɰŋɳɲɴøɵɸθœɶʘɹɺɾɻʀʁɽʂʃʈʧʉʊʋⱱʌɣɤʍχʎʏʑʐʒʔʡʕʢǀǁǂǃˈˌːˑʼʴʰʱʲʷˠˤ˞↓↑→↗↘'̩'ᵻ";
const TOKEN_RE = /[\p{L}\p{M}\p{N}_]+|[^\p{L}\p{M}\p{N}_\s]/gu;

const SYMBOL_TO_ID = new Map(
  [PAD, ...PUNCTUATION, ...LETTERS, ...LETTERS_IPA].map((symbol, index) => [symbol, index]),
);

function arraysEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

export function reconstructPreservedPunctuation(text, phonemeParts) {
  const separators = Array.from(text.matchAll(PRESERVED_PUNCTUATION_RE), (match) => match[0]);
  if (separators.length !== phonemeParts.length && separators.length !== phonemeParts.length - 1) {
    throw new Error(
      `phonemizer.js punctuation mismatch for '${text}': ${separators.length} separators, ` +
        `${phonemeParts.length} phoneme parts`,
    );
  }

  let output = "";
  for (let index = 0; index < phonemeParts.length; index += 1) {
    output += phonemeParts[index] ?? "";
    const separator = separators[index];
    if (separator) {
      output += `${separator} `;
    }
  }
  return output;
}

export async function phonemizeWithPreservedPunctuation(text, language = "en-us") {
  let output = "";
  let cursor = 0;
  for (const match of text.matchAll(PRESERVED_PUNCTUATION_RE)) {
    const punctuationStart = match.index;
    const phraseWithSpacing = text.slice(cursor, punctuationStart);
    const trailingSpacing = phraseWithSpacing.match(/\s*$/)?.[0] ?? "";
    const phrase = phraseWithSpacing.slice(0, phraseWithSpacing.length - trailingSpacing.length);
    if (phrase) {
      output += (await phonemizeJs(phrase, language)).join(" ");
    }
    output += trailingSpacing;
    const punctuation = match[0];
    let nextCursor = punctuationStart + punctuation.length;
    while (nextCursor < text.length && /\s/.test(text[nextCursor] ?? "")) {
      nextCursor += 1;
    }
    const spacing = text.slice(punctuationStart + punctuation.length, nextCursor);
    output += punctuation + (spacing || (nextCursor === text.length ? " " : ""));
    cursor = nextCursor;
  }
  const tail = text.slice(cursor);
  if (tail) {
    output += (await phonemizeJs(tail, language)).join(" ");
  }
  return output;
}

export function normalizePhonemizerJsOutput(phonemes, compatibilityMode = "python-espeak") {
  if (compatibilityMode !== "python-espeak") {
    return phonemes;
  }
  return phonemes.replace(/oː(?=ɹ)/g, "ɔː");
}

export function tokenizePhonemes(phonemesRaw) {
  return (phonemesRaw.match(TOKEN_RE) ?? []).join(" ");
}

export function textCleaner(text) {
  const ids = [];
  for (const char of text) {
    const id = SYMBOL_TO_ID.get(char);
    if (id !== undefined) {
      ids.push(id);
    }
  }
  return ids;
}

export function phonemesToInputIds(phonemesRaw) {
  const phonemes = tokenizePhonemes(phonemesRaw);
  return [0, ...textCleaner(phonemes), 10, 0];
}

export async function buildBrowserPhonemeInput(
  text,
  { language = "en-us", compatibilityMode = "python-espeak" } = {},
) {
  const rebuilt = await phonemizeWithPreservedPunctuation(text, language);
  const phonemesRaw = normalizePhonemizerJsOutput(rebuilt, compatibilityMode);
  return {
    phonemesRaw,
    inputIds: phonemesToInputIds(phonemesRaw),
  };
}

export async function verifyManifestBrowserInputs(
  manifest,
  { maxMismatches = 5, language = "en-us", compatibilityMode = "python-espeak" } = {},
) {
  const mismatches = [];
  let totalChunks = 0;
  let phonemeExactChunks = 0;
  let inputIdExactChunks = 0;

  for (const fixtureCase of manifest.cases) {
    for (const chunk of fixtureCase.chunks) {
      totalChunks += 1;
      const rebuilt = await buildBrowserPhonemeInput(chunk.text, { language, compatibilityMode });

      if (rebuilt.phonemesRaw === chunk.phonemes_raw) {
        phonemeExactChunks += 1;
      } else if (mismatches.length < maxMismatches) {
        mismatches.push({
          caseId: fixtureCase.id,
          chunkIndex: chunk.index,
          field: "phonemes_raw",
          expected: chunk.phonemes_raw,
          actual: rebuilt.phonemesRaw,
        });
      }

      if (arraysEqual(rebuilt.inputIds, chunk.input_ids)) {
        inputIdExactChunks += 1;
      } else if (mismatches.length < maxMismatches) {
        mismatches.push({
          caseId: fixtureCase.id,
          chunkIndex: chunk.index,
          field: "input_ids",
          expectedLength: chunk.input_ids.length,
          actualLength: rebuilt.inputIds.length,
          expectedPreview: chunk.input_ids.slice(0, 16),
          actualPreview: rebuilt.inputIds.slice(0, 16),
        });
      }
    }
  }

  return {
    totalChunks,
    phonemeExactChunks,
    inputIdExactChunks,
    mismatches,
  };
}
