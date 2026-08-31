import { createMp3Encoder } from "wasm-media-encoders";

export interface EncodeMp3Options {
  sampleRate: number;
  bitrate?: 8 | 16 | 24 | 32 | 40 | 48 | 64 | 80 | 96 | 112 | 128 | 160 | 192 | 224 | 256 | 320;
  vbrQuality?: number;
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

export async function encodeMp3(samples: Float32Array, options: EncodeMp3Options): Promise<Uint8Array> {
  if (!Number.isInteger(options.sampleRate) || options.sampleRate <= 0) {
    throw new Error("sampleRate must be a positive integer");
  }
  if (options.bitrate !== undefined && options.vbrQuality !== undefined) {
    throw new Error("choose either MP3 bitrate or vbrQuality, not both");
  }
  const supportedRates = new Set([8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000]);
  if (!supportedRates.has(options.sampleRate)) throw new Error(`unsupported MP3 sample rate '${options.sampleRate}'`);
  const encoder = await createMp3Encoder();
  encoder.configure({
    channels: 1,
    sampleRate: options.sampleRate,
    outputSampleRate: options.sampleRate as 8000 | 11025 | 12000 | 16000 | 22050 | 24000 | 32000 | 44100 | 48000,
    ...(options.vbrQuality === undefined ? { bitrate: options.bitrate ?? 128 } : { vbrQuality: options.vbrQuality }),
  });
  const parts: Uint8Array[] = [];
  const frameSize = 1152 * 16;
  for (let offset = 0; offset < samples.length; offset += frameSize) {
    parts.push(encoder.encode([samples.subarray(offset, offset + frameSize)]).slice());
  }
  parts.push(encoder.finalize().slice());
  return concatenate(parts);
}
