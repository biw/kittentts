import { phonemesToInputIds, type FixtureChunk, type FixtureManifest } from "./phoneme-feeds.js";
import type { Phonemizer } from "./phonemizer.js";
import { chunkText, preprocessForTts } from "./text-preprocess.js";
import { type NpyMatrix, type VoicesNpz, selectStyleRow } from "./voices-npz.js";

export interface VoiceResolutionConfig {
  voiceAliases?: Record<string, string>;
  speedPriors?: Record<string, number>;
}

export interface BuildPipelineFeedsOptions extends VoiceResolutionConfig {
  text: string;
  voice: string;
  speed: number;
  cleanText: boolean;
  phonemizer: Phonemizer;
  voices: VoicesNpz;
}

export interface PipelineChunkFeeds {
  text: string;
  resolvedVoice: string;
  effectiveSpeed: number;
  phonemesRaw: string;
  inputIds: number[];
  refId: number;
  styleShape: readonly [1, number];
  style: Float32Array;
}

export function resolveVoice(voice: string, config: VoiceResolutionConfig = {}): string {
  return config.voiceAliases?.[voice] ?? voice;
}

function toFloat32Scalar(value: number): number {
  return new Float32Array([value])[0] ?? value;
}

export function effectiveSpeed(voice: string, speed: number, config: VoiceResolutionConfig = {}): number {
  return toFloat32Scalar(speed * (config.speedPriors?.[voice] ?? 1.0));
}

function selectVoiceMatrix(voices: VoicesNpz, voice: string): NpyMatrix {
  const matrix = voices[voice];
  if (!matrix) {
    throw new Error(`missing voice matrix for '${voice}'`);
  }
  return matrix;
}

export async function buildPipelineFeeds(
  options: BuildPipelineFeedsOptions,
): Promise<{ cleanedText: string; chunks: PipelineChunkFeeds[] }> {
  if (typeof options.text !== "string" || !options.text.trim()) {
    throw new Error("text must contain at least one non-whitespace character");
  }
  if (typeof options.voice !== "string" || !options.voice.trim()) {
    throw new Error("voice must contain at least one non-whitespace character");
  }
  if (!Number.isFinite(options.speed) || options.speed <= 0) {
    throw new Error("speed must be a finite number greater than zero");
  }
  const cleanedText = options.cleanText ? preprocessForTts(options.text) : options.text;
  if (!cleanedText.trim()) {
    throw new Error("text preprocessing produced no speakable text");
  }
  const textChunks = chunkText(cleanedText);
  const resolvedVoice = resolveVoice(options.voice, options);
  const speed = effectiveSpeed(resolvedVoice, options.speed, options);
  const voiceMatrix = selectVoiceMatrix(options.voices, resolvedVoice);

  const chunks = await Promise.all(
    textChunks.map(async (textChunk) => {
      const phonemesRaw = await options.phonemizer.phonemize(textChunk);
      const selectedStyle = selectStyleRow(voiceMatrix, textChunk.length);
      return {
        text: textChunk,
        resolvedVoice,
        effectiveSpeed: speed,
        phonemesRaw,
        inputIds: phonemesToInputIds(phonemesRaw),
        refId: selectedStyle.refId,
        styleShape: selectedStyle.styleShape,
        style: selectedStyle.style,
      };
    }),
  );

  return { cleanedText, chunks };
}

export function chunkMatchesFixture(chunk: PipelineChunkFeeds, fixtureChunk: FixtureChunk): boolean {
  if (chunk.text !== fixtureChunk.text) return false;
  if (chunk.resolvedVoice !== fixtureChunk.resolved_voice) return false;
  if (chunk.effectiveSpeed !== fixtureChunk.effective_speed) return false;
  if (chunk.phonemesRaw !== fixtureChunk.phonemes_raw) return false;
  if (chunk.refId !== fixtureChunk.ref_id) return false;
  if (chunk.inputIds.length !== fixtureChunk.input_ids.length) return false;
  if (chunk.styleShape[0] !== fixtureChunk.style_shape[0] || chunk.styleShape[1] !== fixtureChunk.style_shape[1]) {
    return false;
  }
  for (let index = 0; index < chunk.inputIds.length; index += 1) {
    if (chunk.inputIds[index] !== fixtureChunk.input_ids[index]) return false;
  }
  const expectedStyle = fixtureChunk.style[0];
  if (!expectedStyle || chunk.style.length !== expectedStyle.length) return false;
  for (let index = 0; index < chunk.style.length; index += 1) {
    if (chunk.style[index] !== expectedStyle[index]) return false;
  }
  return true;
}

export function pipelineConfigFromManifest(manifest: FixtureManifest): VoiceResolutionConfig {
  return {
    speedPriors: manifest.speed_priors,
    voiceAliases: manifest.voice_aliases,
  };
}
