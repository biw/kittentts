import type { FixtureManifest } from "./phoneme-feeds.js";

export interface Phonemizer {
  phonemize(text: string): Promise<string>;
  dispose?(): void | Promise<void>;
}

export interface PhonemizerJsOptions {
  language?: string;
  compatibilityMode?: "none" | "python-espeak";
}

const PRESERVED_PUNCTUATION_RE = /[,:;.!?¡¿—…«»"“”]+/g;
let phonemizerJsModulePromise: Promise<typeof import("phonemizer")> | null = null;

function ensureReadableStreamAsyncIterator(): void {
  if (typeof ReadableStream === "undefined" || ReadableStream.prototype[Symbol.asyncIterator]) {
    return;
  }
  Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, {
    configurable: true,
    async *value(this: ReadableStream<Uint8Array>) {
      const reader = this.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          yield value;
        }
      } finally {
        reader.releaseLock();
      }
    },
  });
}

async function loadPhonemizerJs() {
  ensureReadableStreamAsyncIterator();
  phonemizerJsModulePromise ??= import("phonemizer");
  return phonemizerJsModulePromise;
}

export async function phonemizeWithPreservedPunctuation(
  text: string,
  language: string,
  phonemizeImpl: (text: string, language: string) => Promise<string[]>,
): Promise<string> {
  let output = "";
  let cursor = 0;
  for (const match of text.matchAll(PRESERVED_PUNCTUATION_RE)) {
    const punctuationStart = match.index;
    const phraseWithSpacing = text.slice(cursor, punctuationStart);
    const trailingSpacing = phraseWithSpacing.match(/\s*$/)?.[0] ?? "";
    const phrase = phraseWithSpacing.slice(0, phraseWithSpacing.length - trailingSpacing.length);
    if (phrase) {
      output += (await phonemizeImpl(phrase, language)).join(" ");
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
    output += (await phonemizeImpl(tail, language)).join(" ");
  }
  return output;
}

export function reconstructPreservedPunctuation(text: string, phonemeParts: readonly string[]): string {
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

export function normalizePhonemizerJsOutput(
  phonemes: string,
  compatibilityMode: PhonemizerJsOptions["compatibilityMode"] = "python-espeak",
): string {
  if (compatibilityMode !== "python-espeak") {
    return phonemes;
  }

  // phonemizer.js and the Python eSpeak build differ on a small set of /oːɹ/ vowels.
  return phonemes.replace(/oː(?=ɹ)/g, "ɔː");
}

export class PhonemizerJsPhonemizer implements Phonemizer {
  readonly #language: string;
  readonly #compatibilityMode: PhonemizerJsOptions["compatibilityMode"];

  constructor(options: PhonemizerJsOptions = {}) {
    this.#language = options.language ?? "en-us";
    this.#compatibilityMode = options.compatibilityMode ?? "python-espeak";
  }

  async phonemize(text: string): Promise<string> {
    const { phonemize: phonemizeJs } = await loadPhonemizerJs();
    const rebuilt = await phonemizeWithPreservedPunctuation(text, this.#language, phonemizeJs);
    return normalizePhonemizerJsOutput(rebuilt, this.#compatibilityMode);
  }
}

export class FixturePhonemizer implements Phonemizer {
  private readonly phonemesByChunk = new Map<string, string>();

  constructor(entries: Iterable<readonly [string, string]>) {
    for (const [chunkText, phonemes] of entries) {
      const existing = this.phonemesByChunk.get(chunkText);
      if (existing && existing !== phonemes) {
        throw new Error(`conflicting fixture phonemes for chunk: ${chunkText}`);
      }
      this.phonemesByChunk.set(chunkText, phonemes);
    }
  }

  static fromManifest(manifest: FixtureManifest): FixturePhonemizer {
    const entries: Array<readonly [string, string]> = [];
    for (const fixtureCase of manifest.cases) {
      for (const chunk of fixtureCase.chunks) {
        entries.push([chunk.text, chunk.phonemes_raw]);
      }
    }
    return new FixturePhonemizer(entries);
  }

  async phonemize(text: string): Promise<string> {
    const phonemes = this.phonemesByChunk.get(text);
    if (!phonemes) {
      throw new Error(`no fixture phonemes found for chunk: ${text}`);
    }
    return phonemes;
  }
}
