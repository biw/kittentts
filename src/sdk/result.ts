import { encodeWav, type EncodeWavOptions } from "../audio/index.js";
import { uint8ArrayToBase64 } from "../audio/base64.js";
import type { KittenTtsBackendChunk, KittenTtsBackendResult, KittenTtsTokenTiming } from "./contracts.js";
import type { EncodeMp3Options } from "../audio/mp3.js";

export class KittenTtsResult {
  readonly sampleRate: number;
  readonly executionProviders: readonly string[];
  readonly cleanedText: string;
  readonly chunks: readonly KittenTtsBackendChunk[];
  readonly audio: Float32Array;

  constructor(result: KittenTtsBackendResult) {
    this.sampleRate = result.sampleRate;
    this.executionProviders = Object.freeze([...result.executionProviders]);
    this.cleanedText = result.cleanedText;
    this.chunks = Object.freeze([...result.chunks]);
    this.audio = result.audio;
  }

  get durationSeconds(): number {
    return this.audio.length / this.sampleRate;
  }

  get tokenTimings(): readonly KittenTtsTokenTiming[] {
    const timings: KittenTtsTokenTiming[] = [];
    let chunkOffset = 0;
    this.chunks.forEach((chunk, chunkIndex) => {
      const durations = chunk.durations;
      const total = durations?.reduce((sum, value) => sum + value, 0) ?? 0;
      if (durations && total > 0) {
        let cursor = 0;
        durations.forEach((duration, tokenIndex) => {
          const start = chunkOffset + (cursor / total) * (chunk.audio.length / this.sampleRate);
          cursor += duration;
          const end = chunkOffset + (cursor / total) * (chunk.audio.length / this.sampleRate);
          timings.push({ chunkIndex, tokenIndex, tokenId: chunk.inputIds[tokenIndex] ?? 0, startSeconds: start, endSeconds: end });
        });
      }
      chunkOffset += chunk.audio.length / this.sampleRate;
    });
    return Object.freeze(timings);
  }

  wavData(options: Omit<EncodeWavOptions, "sampleRate"> = {}): Uint8Array {
    return encodeWav(this.audio, { ...options, sampleRate: this.sampleRate });
  }

  wavBase64(options: Omit<EncodeWavOptions, "sampleRate"> = {}): string {
    return uint8ArrayToBase64(this.wavData(options));
  }

  async mp3Data(options: Omit<EncodeMp3Options, "sampleRate"> = {}): Promise<Uint8Array> {
    const { encodeMp3 } = await import("../audio/mp3.js");
    return encodeMp3(this.audio, { ...options, sampleRate: this.sampleRate });
  }
}
