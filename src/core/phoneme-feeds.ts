export interface FixtureChunk {
  index: number;
  text: string;
  resolved_voice: string;
  effective_speed: number;
  phonemes_raw: string;
  phonemes_tokenized: string;
  input_ids: number[];
  ref_id: number;
  style_shape: number[];
  style: number[][];
  speed: number[];
  audio: AudioStats;
}

export interface FixtureCase {
  id: string;
  text: string;
  voice: string;
  speed: number;
  clean_text: boolean;
  cleaned_text: string;
  chunk_count: number;
  wav_path: string;
  raw_audio_path: string;
  audio: AudioStats;
  chunks: FixtureChunk[];
}

export interface FixtureManifest {
  schema_version: number;
  generated_at_utc: string;
  model: string;
  revision?: string;
  model_path: string;
  model_asset_path: string;
  voices_asset_path?: string;
  speed_priors?: Record<string, number>;
  voice_aliases?: Record<string, string>;
  sample_rate: number;
  corpus_path: string;
  cases: FixtureCase[];
}

export interface AudioStats {
  num_samples: number;
  min: number;
  max: number;
  mean: number;
  std: number;
  rms: number;
  float32_sha256?: string;
  signature: AudioSignature;
}

export interface AudioSignature {
  bins: number;
  rms: number[];
  delta_rms: number[];
  zero_crossing_rate: number[];
}

export const MODEL_AUDIO_TRIM_SAMPLES = 5000;

export const AUDIO_TOLERANCES = {
  min: 0.15,
  max: 0.15,
  mean: 5e-4,
  std: 5e-4,
  rms: 5e-4,
} as const;

export const CORPUS_AUDIO_TOLERANCES = {
  mean: 2e-3,
  std: 3e-3,
  rms: 3e-3,
} as const;

export const AUDIO_SIGNATURE_TOLERANCES = {
  rms: 3e-3,
  deltaRms: 1e-3,
  zeroCrossingRate: 1e-2,
} as const;

const PAD = "$";
const PUNCTUATION = ';:,.!?¡¿—…"«»"" ';
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const LETTERS_IPA =
  "ɑɐɒæɓʙβɔɕçɗɖðʤəɘɚɛɜɝɞɟʄɡɠɢʛɦɧħɥʜɨɪʝɭɬɫɮʟɱɯɰŋɳɲɴøɵɸθœɶʘɹɺɾɻʀʁɽʂʃʈʧʉʊʋⱱʌɣɤʍχʎʏʑʐʒʔʡʕʢǀǁǂǃˈˌːˑʼʴʰʱʲʷˠˤ˞↓↑→↗↘'̩'ᵻ";
// Python's `\w+|[^\w\s]` treats IPA combining marks as standalone tokens.
const TOKEN_RE = /[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]/gu;

const SYMBOL_TO_ID = new Map(
  [PAD, ...PUNCTUATION, ...LETTERS, ...LETTERS_IPA].map((symbol, index) => [symbol, index]),
);

export function basicEnglishTokenize(text: string): string[] {
  return text.match(TOKEN_RE) ?? [];
}

export function tokenizePhonemes(phonemesRaw: string): string {
  return basicEnglishTokenize(phonemesRaw).join(" ");
}

export function textCleaner(text: string): number[] {
  const ids: number[] = [];
  for (const char of text) {
    const id = SYMBOL_TO_ID.get(char);
    if (id !== undefined) {
      ids.push(id);
    }
  }
  return ids;
}

export function phonemesToInputIds(phonemesRaw: string): number[] {
  const phonemes = tokenizePhonemes(phonemesRaw);
  return [0, ...textCleaner(phonemes), 10, 0];
}

export function buildChunkFeeds(chunk: FixtureChunk) {
  return {
    inputIds: phonemesToInputIds(chunk.phonemes_raw),
    styleShape: chunk.style_shape,
    style: chunk.style,
    speed: chunk.speed,
  };
}

export function trimModelAudio(audio: Float32Array): Float32Array {
  return audio.slice(0, audio.length - MODEL_AUDIO_TRIM_SAMPLES);
}

export function summarizeAudio(audio: ArrayLike<number>): AudioStats {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let sumSq = 0;
  for (let index = 0; index < audio.length; index += 1) {
    const value = audio[index];
    if (value < min) {
      min = value;
    }
    if (value > max) {
      max = value;
    }
    sum += value;
    sumSq += value * value;
  }
  const mean = sum / audio.length;
  let varianceSum = 0;
  for (let index = 0; index < audio.length; index += 1) {
    const value = audio[index];
    const delta = value - mean;
    varianceSum += delta * delta;
  }
  return {
    num_samples: audio.length,
    min,
    max,
    mean,
    std: Math.sqrt(varianceSum / audio.length),
    rms: Math.sqrt(sumSq / audio.length),
    signature: summarizeAudioSignature(audio),
  };
}

export function summarizeAudioSignature(audio: ArrayLike<number>, bins = 32): AudioSignature {
  const rms: number[] = [];
  const deltaRms: number[] = [];
  const zeroCrossingRate: number[] = [];
  for (let bin = 0; bin < bins; bin += 1) {
    const start = Math.floor((bin * audio.length) / bins);
    const end = Math.floor(((bin + 1) * audio.length) / bins);
    let sumSquares = 0;
    let deltaSquares = 0;
    let crossings = 0;
    for (let index = start; index < end; index += 1) {
      const value = audio[index] ?? 0;
      sumSquares += value * value;
      if (index > start) {
        const previous = audio[index - 1] ?? 0;
        const delta = value - previous;
        deltaSquares += delta * delta;
        if ((previous < 0) !== (value < 0)) {
          crossings += 1;
        }
      }
    }
    const sampleCount = Math.max(1, end - start);
    const deltaCount = Math.max(1, sampleCount - 1);
    rms.push(Math.sqrt(sumSquares / sampleCount));
    deltaRms.push(Math.sqrt(deltaSquares / deltaCount));
    zeroCrossingRate.push(crossings / deltaCount);
  }
  return {
    bins,
    rms,
    delta_rms: deltaRms,
    zero_crossing_rate: zeroCrossingRate,
  };
}

function meanAbsoluteDelta(actual: readonly number[], expected: readonly number[]): number {
  if (actual.length !== expected.length || actual.length === 0) {
    return Infinity;
  }
  let sum = 0;
  for (let index = 0; index < actual.length; index += 1) {
    sum += Math.abs((actual[index] ?? 0) - (expected[index] ?? 0));
  }
  return sum / actual.length;
}

export function audioSignatureDeltas(actual: AudioSignature, expected: AudioSignature) {
  if (actual.bins !== expected.bins) {
    return { rms: Infinity, deltaRms: Infinity, zeroCrossingRate: Infinity };
  }
  return {
    rms: meanAbsoluteDelta(actual.rms, expected.rms),
    deltaRms: meanAbsoluteDelta(actual.delta_rms, expected.delta_rms),
    zeroCrossingRate: meanAbsoluteDelta(actual.zero_crossing_rate, expected.zero_crossing_rate),
  };
}

export function audioDeltas(actual: AudioStats, expected: AudioStats) {
  return {
    min: Math.abs(actual.min - expected.min),
    max: Math.abs(actual.max - expected.max),
    mean: Math.abs(actual.mean - expected.mean),
    std: Math.abs(actual.std - expected.std),
    rms: Math.abs(actual.rms - expected.rms),
  };
}
