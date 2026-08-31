export interface EncodeWavOptions {
  sampleRate: number;
  format?: "pcm16" | "float32";
}

function clampPcmSample(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function encodePcm16(samples: ArrayLike<number>): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = clampPcmSample(samples[index] ?? 0);
    pcm[index] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
  }
  return pcm;
}

function encodeFloat32(samples: ArrayLike<number>): Float32Array {
  const pcm = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    pcm[index] = samples[index] ?? 0;
  }
  return pcm;
}

export function encodeWav(samples: ArrayLike<number>, options: EncodeWavOptions): Uint8Array {
  if (!Number.isInteger(options.sampleRate) || options.sampleRate <= 0) {
    throw new Error("sampleRate must be a positive integer");
  }
  const format = options.format ?? "pcm16";
  if (format !== "pcm16" && format !== "float32") {
    throw new Error(`unsupported WAV format '${String(format)}'`);
  }
  const encodedSamples = format === "float32" ? encodeFloat32(samples) : encodePcm16(samples);
  const bytesPerSample = format === "float32" ? 4 : 2;
  const audioFormat = format === "float32" ? 3 : 1;
  const dataSize = encodedSamples.byteLength;
  const wavBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(wavBuffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, audioFormat, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, options.sampleRate, true);
  view.setUint32(28, options.sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  new Uint8Array(wavBuffer, 44).set(
    new Uint8Array(
      encodedSamples.buffer,
      encodedSamples.byteOffset,
      encodedSamples.byteLength,
    ),
  );

  return new Uint8Array(wavBuffer);
}

export { joinAudio } from "./join.js";
