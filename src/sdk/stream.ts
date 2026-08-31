import { joinAudio } from "../audio/join.js";
import type { KittenTtsBackendChunk, KittenTtsStreamChunk } from "./contracts.js";
import { KittenTtsResult } from "./result.js";

export interface CollectKittenTtsStreamOptions {
  crossfadeMs?: number;
}

export async function collectKittenTtsStream(
  stream: AsyncIterable<KittenTtsStreamChunk>,
  options: CollectKittenTtsStreamOptions = {},
): Promise<KittenTtsResult> {
  const results: KittenTtsStreamChunk[] = [];
  for await (const chunk of stream) results.push(chunk);
  if (results.length === 0) throw new Error("cannot collect an empty KittenTTS stream");
  const sampleRate = results[0].result.sampleRate;
  if (results.some((chunk) => chunk.result.sampleRate !== sampleRate)) {
    throw new Error("stream chunks have inconsistent sample rates");
  }
  const crossfadeSamples = Math.round(((options.crossfadeMs ?? 0) / 1000) * sampleRate);
  return new KittenTtsResult({
    sampleRate,
    executionProviders: [...results[0].result.executionProviders],
    cleanedText: results.map((chunk) => chunk.result.cleanedText).join(" "),
    chunks: results.flatMap((chunk) => chunk.result.chunks) as KittenTtsBackendChunk[],
    audio: joinAudio(results.map((chunk) => chunk.result.audio), crossfadeSamples),
  });
}
