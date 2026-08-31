import { unzipSync } from "/node_modules/fflate/esm/browser.js";
const ONES = [
  "",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALE = ["", "thousand", "million", "billion", "trillion"];
const CURRENCY_SYMBOLS = {
  $: "dollar",
  "\u20ac": "euro",
  "\u00a3": "pound",
  "\u00a5": "yen",
  "\u20b9": "rupee",
  "\u20a9": "won",
  "\u20bf": "bitcoin",
};
const RE_URL = /https?:\/\/\S+|www\.\S+/gi;
const RE_EMAIL = /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/gi;
const RE_HTML = /<[^>]+>/g;
const RE_SPACES = /\s+/g;
const RE_PUNCT = /[^\w\s.,?!;:\-\u2014\u2013\u2026]/gu;
const RE_NUMBER = /(?<![a-zA-Z])-?[\d,]+(?:\.\d+)?/g;
const RE_PERCENT = /(-?[\d,]+(?:\.\d+)?)\s*%/g;
const RE_CURRENCY = /([$€£¥₹₩₿])\s*([\d,]+(?:\.\d+)?)\s*([KMBT])?(?![a-zA-Z\d])/g;
const RE_TIME = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?\b/gi;
const RE_RANGE = /(?<!\w)(\d+)-(\d+)(?!\w)/g;
const RE_MODEL_VER = /\b([a-zA-Z][a-zA-Z0-9]*)-(\d[\d.]*)(?=[^\d.]|$)/g;
const RE_LEAD_DEC = /(?<!\d)\.([\d])/g;
const RE_SPLIT_SENTENCES = /[.!?]+/;

const voicesCache = new Map();
const DEFAULT_ASSET_BASE_URL = "/.context/reference-fixtures/";
let browserPhonemizerModulePromise = null;

function pushMismatch(report, entry, maxMismatches) {
  if (report.mismatches.length < maxMismatches) {
    report.mismatches.push(entry);
  }
}

export function resolveBrowserAssetUrl(assetPath, { assetBaseUrl = DEFAULT_ASSET_BASE_URL } = {}) {
  if (!assetPath) {
    throw new Error("asset path is required");
  }
  return new URL(assetPath, new URL(assetBaseUrl, self.location.href)).toString();
}

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

async function loadBrowserPhonemizerModule() {
  browserPhonemizerModulePromise ??= import("/web/browser-phonemizer.mjs");
  return browserPhonemizerModulePromise;
}

function decodeHeader(bytes) {
  return new TextDecoder("latin1").decode(bytes);
}

function parseShape(header) {
  const match = header.match(/'shape':\s*\(([^)]*)\)/);
  if (!match) {
    throw new Error(`missing shape in npy header: ${header}`);
  }
  const dims = match[1]
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => Number.parseInt(value, 10));
  if (dims.length !== 2 || dims.some((value) => !Number.isFinite(value))) {
    throw new Error(`expected 2D shape in npy header: ${header}`);
  }
  return [dims[0], dims[1]];
}

function parseNpy(buffer) {
  const magic = String.fromCharCode(...buffer.slice(0, 6));
  if (magic !== "\u0093NUMPY") {
    throw new Error("invalid npy magic header");
  }

  const major = buffer[6];
  const headerLength =
    major === 1
      ? buffer[8] | (buffer[9] << 8)
      : buffer[8] | (buffer[9] << 8) | (buffer[10] << 16) | (buffer[11] << 24);
  const headerOffset = major === 1 ? 10 : 12;
  const header = decodeHeader(buffer.slice(headerOffset, headerOffset + headerLength));
  if (!header.includes("'descr': '<f4'")) {
    throw new Error(`unsupported npy dtype: ${header}`);
  }
  if (!header.includes("'fortran_order': False")) {
    throw new Error(`fortran-order arrays are not supported: ${header}`);
  }

  const shape = parseShape(header);
  const dataOffset = headerOffset + headerLength;
  const dataBytes = buffer.slice(dataOffset);
  const arrayBuffer = dataBytes.buffer.slice(
    dataBytes.byteOffset,
    dataBytes.byteOffset + dataBytes.byteLength,
  );
  const data = new Float32Array(arrayBuffer);
  if (data.length !== shape[0] * shape[1]) {
    throw new Error(`unexpected npy data length: got ${data.length}, expected ${shape[0] * shape[1]}`);
  }
  return { shape, data };
}

function loadVoicesNpz(npzBytes) {
  const archive = unzipSync(npzBytes);
  const voices = {};
  for (const [filename, bytes] of Object.entries(archive)) {
    if (!filename.endsWith(".npy")) {
      continue;
    }
    voices[filename.slice(0, -4)] = parseNpy(bytes);
  }
  return voices;
}

function selectStyleRow(voice, textLength) {
  const [rows, cols] = voice.shape;
  const refId = Math.min(textLength, rows - 1);
  const offset = refId * cols;
  return {
    refId,
    styleShape: [1, cols],
    style: voice.data.slice(offset, offset + cols),
  };
}

function threeDigitsToWords(value) {
  if (value === 0) {
    return "";
  }
  const parts = [];
  const hundreds = Math.floor(value / 100);
  const remainder = value % 100;
  if (hundreds) {
    parts.push(`${ONES[hundreds]} hundred`);
  }
  if (remainder < 20) {
    if (remainder) {
      parts.push(ONES[remainder]);
    }
  } else {
    const tensWord = TENS[Math.floor(remainder / 10)];
    const onesWord = ONES[remainder % 10];
    parts.push(onesWord ? `${tensWord}-${onesWord}` : tensWord);
  }
  return parts.join(" ");
}

function numberToWords(value) {
  let n = Number.parseInt(String(value), 10);
  if (n === 0) {
    return "zero";
  }
  if (n < 0) {
    return `negative ${numberToWords(-n)}`;
  }
  if (n >= 100 && n <= 9999 && n % 100 === 0 && n % 1000 !== 0) {
    const hundreds = Math.floor(n / 100);
    if (hundreds < 20) {
      return `${ONES[hundreds]} hundred`;
    }
  }

  const parts = [];
  for (let scaleIndex = 0; scaleIndex < SCALE.length; scaleIndex += 1) {
    const chunk = n % 1000;
    if (chunk) {
      const chunkWords = threeDigitsToWords(chunk);
      parts.push(SCALE[scaleIndex] ? `${chunkWords} ${SCALE[scaleIndex]}` : chunkWords);
    }
    n = Math.floor(n / 1000);
    if (n === 0) {
      break;
    }
  }
  return parts.reverse().join(" ");
}

function floatToWords(value, decimalSep = "point") {
  let text = typeof value === "string" ? value : String(value);
  const negative = text.startsWith("-");
  if (negative) {
    text = text.slice(1);
  }

  const result = text.includes(".")
    ? (() => {
        const [intPart, decPart] = text.split(".", 2);
        const intWords = intPart ? numberToWords(Number.parseInt(intPart, 10)) : "zero";
        const decWords = decPart
          .split("")
          .map((digit) => (digit === "0" ? "zero" : ONES[Number.parseInt(digit, 10)]))
          .join(" ");
        return `${intWords} ${decimalSep} ${decWords}`;
      })()
    : numberToWords(Number.parseInt(text, 10));

  return negative ? `negative ${result}` : result;
}

function normalizeUnicode(text, form = "NFC") {
  return text.normalize(form);
}

function removeHtmlTags(text) {
  return text.replace(RE_HTML, " ");
}

function removeUrls(text, replacement = "") {
  return text.replace(RE_URL, replacement).trim();
}

function removeEmails(text, replacement = "") {
  return text.replace(RE_EMAIL, replacement).trim();
}

function expandContractions(text) {
  const contractions = [
    [/\bcan't\b/gi, "cannot"],
    [/\bwon't\b/gi, "will not"],
    [/\bshan't\b/gi, "shall not"],
    [/\bain't\b/gi, "is not"],
    [/\blet's\b/gi, "let us"],
    [/\b(\w+)n't\b/gi, "$1 not"],
    [/\b(\w+)'re\b/gi, "$1 are"],
    [/\b(\w+)'ve\b/gi, "$1 have"],
    [/\b(\w+)'ll\b/gi, "$1 will"],
    [/\b(\w+)'d\b/gi, "$1 would"],
    [/\b(\w+)'m\b/gi, "$1 am"],
    [/\bit's\b/gi, "it is"],
  ];
  let expanded = text;
  for (const [pattern, replacement] of contractions) {
    expanded = expanded.replace(pattern, replacement);
  }
  return expanded;
}

function normalizeLeadingDecimals(text) {
  return text.replace(/(?<!\d)(-)\.([\d])/g, "$10.$2").replace(RE_LEAD_DEC, "0.$1");
}

function expandCurrency(text) {
  const scaleMap = {
    K: "thousand",
    M: "million",
    B: "billion",
    T: "trillion",
  };

  return text.replace(RE_CURRENCY, (_, symbol, rawValue, scaleSuffix) => {
    const raw = rawValue.replace(/,/g, "");
    const unit = CURRENCY_SYMBOLS[symbol] ?? "";

    if (scaleSuffix) {
      const scaleWord = scaleMap[scaleSuffix];
      const num = raw.includes(".") ? floatToWords(raw) : numberToWords(Number.parseInt(raw, 10));
      return `${num} ${scaleWord} ${unit}${unit ? "s" : ""}`.trim();
    }

    if (raw.includes(".")) {
      const [intPart, decPart] = raw.split(".", 2);
      const decValue = Number.parseInt(decPart.slice(0, 2).padEnd(2, "0"), 10);
      let result = `${numberToWords(Number.parseInt(intPart, 10))} ${unit}s`.trim();
      if (decValue) {
        result += ` and ${numberToWords(decValue)} cent${decValue === 1 ? "" : "s"}`;
      }
      return result;
    }

    const value = Number.parseInt(raw, 10);
    const words = numberToWords(value);
    return unit ? `${words} ${unit}${value === 1 ? "" : "s"}` : words;
  });
}

function expandPercentages(text) {
  return text.replace(RE_PERCENT, (_, rawValue) => {
    const raw = rawValue.replace(/,/g, "");
    return raw.includes(".")
      ? `${floatToWords(raw)} percent`
      : `${numberToWords(Number.parseInt(raw, 10))} percent`;
  });
}

function expandTime(text) {
  return text.replace(RE_TIME, (_, hours, minutes, _seconds, suffix) => {
    const h = Number.parseInt(hours, 10);
    const mins = Number.parseInt(minutes, 10);
    const normalizedSuffix = suffix ? ` ${suffix.toLowerCase()}` : "";
    const hourWords = numberToWords(h);
    if (mins === 0) {
      return suffix ? `${hourWords}${normalizedSuffix}` : `${hourWords} hundred`;
    }
    if (mins < 10) {
      return `${hourWords} oh ${numberToWords(mins)}${normalizedSuffix}`;
    }
    return `${hourWords} ${numberToWords(mins)}${normalizedSuffix}`;
  });
}

function expandRanges(text) {
  return text.replace(RE_RANGE, (_, lo, hi) => {
    return `${numberToWords(Number.parseInt(lo, 10))} to ${numberToWords(Number.parseInt(hi, 10))}`;
  });
}

function expandModelNames(text) {
  return text.replace(RE_MODEL_VER, "$1 $2");
}

function replaceNumbers(text, replaceFloats = true) {
  return text.replace(RE_NUMBER, (rawMatch) => {
    const raw = rawMatch.replace(/,/g, "");
    try {
      if (raw.includes(".") && replaceFloats) {
        return floatToWords(raw);
      }
      return numberToWords(Number.parseInt(String(Number.parseFloat(raw)), 10));
    } catch {
      return rawMatch;
    }
  });
}

function removePunctuation(text) {
  return text.replace(RE_PUNCT, " ");
}

function toLowercase(text) {
  return text.toLowerCase();
}

function removeExtraWhitespace(text) {
  return text.replace(RE_SPACES, " ").trim();
}

class TextPreprocessor {
  constructor(options = {}) {
    this.options = {
      lowercase: true,
      replaceNumbers: true,
      replaceFloats: true,
      expandContractions: true,
      expandPercentages: true,
      expandCurrency: true,
      expandTime: true,
      expandRanges: true,
      expandModelNames: true,
      normalizeLeadingDecimals: true,
      removeUrls: true,
      removeEmails: true,
      removeHtml: true,
      removePunctuation: true,
      normalizeUnicode: true,
      removeExtraWhitespace: true,
      ...options,
    };
  }

  process(text) {
    let result = text;
    if (this.options.normalizeUnicode) {
      result = normalizeUnicode(result);
    }
    if (this.options.removeHtml) {
      result = removeHtmlTags(result);
    }
    if (this.options.removeUrls) {
      result = removeUrls(result);
    }
    if (this.options.removeEmails) {
      result = removeEmails(result);
    }
    if (this.options.expandContractions) {
      result = expandContractions(result);
    }
    if (this.options.normalizeLeadingDecimals) {
      result = normalizeLeadingDecimals(result);
    }
    if (this.options.expandCurrency) {
      result = expandCurrency(result);
    }
    if (this.options.expandPercentages) {
      result = expandPercentages(result);
    }
    if (this.options.expandTime) {
      result = expandTime(result);
    }
    if (this.options.expandRanges) {
      result = expandRanges(result);
    }
    if (this.options.expandModelNames) {
      result = expandModelNames(result);
    }
    if (this.options.replaceNumbers) {
      result = replaceNumbers(result, this.options.replaceFloats);
    }
    if (this.options.removePunctuation) {
      result = removePunctuation(result);
    }
    if (this.options.lowercase) {
      result = toLowercase(result);
    }
    if (this.options.removeExtraWhitespace) {
      result = removeExtraWhitespace(result);
    }
    return result;
  }
}

function ensurePunctuation(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }
  return /[.!?,;:]$/.test(trimmed) ? trimmed : `${trimmed},`;
}

function chunkText(text, maxLen = 400) {
  const sentences = text.split(RE_SPLIT_SENTENCES);
  const chunks = [];

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.length <= maxLen) {
      chunks.push(ensurePunctuation(trimmed));
      continue;
    }

    let current = "";
    for (const word of trimmed.split(/\s+/)) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length <= maxLen) {
        current = candidate;
      } else {
        if (current) {
          chunks.push(ensurePunctuation(current));
        }
        current = word;
      }
    }
    if (current) {
      chunks.push(ensurePunctuation(current));
    }
  }
  return chunks;
}

function preprocessForTts(text) {
  return new TextPreprocessor({ removePunctuation: false }).process(text);
}

function resolveVoice(voice, voiceAliases = {}) {
  return voiceAliases[voice] ?? voice;
}

function toFloat32Scalar(value) {
  return new Float32Array([value])[0] ?? value;
}

function effectiveSpeed(voice, speed, speedPriors = {}) {
  return toFloat32Scalar(speed * (speedPriors[voice] ?? 1.0));
}

function selectVoiceMatrix(voices, voice) {
  const matrix = voices[voice];
  if (!matrix) {
    throw new Error(`missing voice matrix for '${voice}'`);
  }
  return matrix;
}

export function chunkMatchesFixture(chunk, fixtureChunk) {
  if (chunk.text !== fixtureChunk.text) return false;
  if (chunk.resolvedVoice !== fixtureChunk.resolved_voice) return false;
  if (chunk.effectiveSpeed !== fixtureChunk.effective_speed) return false;
  if (chunk.phonemesRaw !== fixtureChunk.phonemes_raw) return false;
  if (chunk.refId !== fixtureChunk.ref_id) return false;
  if (!arraysEqual(chunk.inputIds, fixtureChunk.input_ids)) return false;
  if (
    chunk.styleShape[0] !== fixtureChunk.style_shape[0] ||
    chunk.styleShape[1] !== fixtureChunk.style_shape[1]
  ) {
    return false;
  }
  const expectedStyle = fixtureChunk.style[0];
  if (!expectedStyle || chunk.style.length !== expectedStyle.length) {
    return false;
  }
  for (let index = 0; index < chunk.style.length; index += 1) {
    if (chunk.style[index] !== expectedStyle[index]) {
      return false;
    }
  }
  return true;
}

export async function loadBrowserVoices(manifest, { voicesUrl, assetBaseUrl } = {}) {
  if (!manifest.voices_asset_path) {
    throw new Error("voices asset path missing from manifest");
  }
  const resolvedVoicesUrl = voicesUrl ?? resolveBrowserAssetUrl(manifest.voices_asset_path, { assetBaseUrl });
  const cacheKey = resolvedVoicesUrl;
  if (!voicesCache.has(cacheKey)) {
    voicesCache.set(
      cacheKey,
      (async () => {
        const response = await fetch(resolvedVoicesUrl);
        if (!response.ok) {
          throw new Error(`failed to load voices npz: ${response.status}`);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        return loadVoicesNpz(bytes);
      })(),
    );
  }
  return voicesCache.get(cacheKey);
}

export async function buildBrowserPipelineFeeds({
  text,
  voice,
  speed,
  cleanText,
  manifest,
  voices,
}) {
  const { buildBrowserPhonemeInput } = await loadBrowserPhonemizerModule();
  const cleanedText = cleanText ? preprocessForTts(text) : text;
  const textChunks = chunkText(cleanedText);
  const resolvedVoice = resolveVoice(voice, manifest.voice_aliases);
  const normalizedSpeed = effectiveSpeed(resolvedVoice, speed, manifest.speed_priors);
  const voiceMatrix = selectVoiceMatrix(voices, resolvedVoice);

  const chunks = await Promise.all(
    textChunks.map(async (textChunk) => {
      const browserInput = await buildBrowserPhonemeInput(textChunk);
      const selectedStyle = selectStyleRow(voiceMatrix, textChunk.length);
      return {
        text: textChunk,
        resolvedVoice,
        effectiveSpeed: normalizedSpeed,
        phonemesRaw: browserInput.phonemesRaw,
        inputIds: browserInput.inputIds,
        refId: selectedStyle.refId,
        styleShape: selectedStyle.styleShape,
        style: selectedStyle.style,
      };
    }),
  );

  return { cleanedText, chunks };
}

export async function verifyManifestBrowserPipeline(
  manifest,
  { maxMismatches = 5, voicesUrl, assetBaseUrl } = {},
) {
  const voices = await loadBrowserVoices(manifest, { voicesUrl, assetBaseUrl });
  const report = {
    totalCases: manifest.cases.length,
    totalChunks: manifest.cases.reduce((count, fixtureCase) => count + fixtureCase.chunks.length, 0),
    cleanedTextExactCases: 0,
    chunkCountExactCases: 0,
    exactChunks: 0,
    mismatches: [],
  };

  for (const fixtureCase of manifest.cases) {
    const pipeline = await buildBrowserPipelineFeeds({
      text: fixtureCase.text,
      voice: fixtureCase.voice,
      speed: fixtureCase.speed,
      cleanText: fixtureCase.clean_text,
      manifest,
      voices,
    });

    if (pipeline.cleanedText === fixtureCase.cleaned_text) {
      report.cleanedTextExactCases += 1;
    } else {
      pushMismatch(
        report,
        {
          caseId: fixtureCase.id,
          field: "cleaned_text",
          expected: fixtureCase.cleaned_text,
          actual: pipeline.cleanedText,
        },
        maxMismatches,
      );
    }

    if (pipeline.chunks.length === fixtureCase.chunks.length) {
      report.chunkCountExactCases += 1;
    } else {
      pushMismatch(
        report,
        {
          caseId: fixtureCase.id,
          field: "chunk_count",
          expected: fixtureCase.chunks.length,
          actual: pipeline.chunks.length,
        },
        maxMismatches,
      );
    }

    const chunkCount = Math.max(pipeline.chunks.length, fixtureCase.chunks.length);
    for (let index = 0; index < chunkCount; index += 1) {
      const browserChunk = pipeline.chunks[index];
      const fixtureChunk = fixtureCase.chunks[index];
      if (browserChunk && fixtureChunk && chunkMatchesFixture(browserChunk, fixtureChunk)) {
        report.exactChunks += 1;
        continue;
      }
      pushMismatch(
        report,
        {
          caseId: fixtureCase.id,
          chunkIndex: index,
          field: "chunk",
          expectedText: fixtureChunk?.text ?? null,
          actualText: browserChunk?.text ?? null,
          expectedResolvedVoice: fixtureChunk?.resolved_voice ?? null,
          actualResolvedVoice: browserChunk?.resolvedVoice ?? null,
          expectedEffectiveSpeed: fixtureChunk?.effective_speed ?? null,
          actualEffectiveSpeed: browserChunk?.effectiveSpeed ?? null,
          expectedPhonemesRaw: fixtureChunk?.phonemes_raw ?? null,
          actualPhonemesRaw: browserChunk?.phonemesRaw ?? null,
          expectedInputIdsPreview: fixtureChunk?.input_ids?.slice(0, 16) ?? null,
          actualInputIdsPreview: browserChunk?.inputIds?.slice(0, 16) ?? null,
          expectedRefId: fixtureChunk?.ref_id ?? null,
          actualRefId: browserChunk?.refId ?? null,
        },
        maxMismatches,
      );
    }
  }

  return report;
}
