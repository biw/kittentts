import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const REQUIRED_COLD_DOWNLOADS = [
  "config.json",
  "kitten_tts_nano_v0_8.onnx",
  "phonemizer-list",
  "phonemizer-rules",
  "voices.npz",
] as const;

type NativePlatform = "android" | "ios";

type SignalMetrics = {
  samples: number;
  durationSeconds: number;
  peak: number;
  rms: number;
  initMs: number;
  synthesisMs: number;
};

function check(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`invalid React Native smoke artifact: ${message}`);
  }
}

function record(value: unknown, name: string): Record<string, unknown> {
  check(typeof value === "object" && value !== null && !Array.isArray(value), `${name} must be an object`);
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown, name: string): number {
  check(typeof value === "number" && Number.isFinite(value), `${name} must be a finite number`);
  return value;
}

function stringArray(value: unknown, name: string): string[] {
  check(Array.isArray(value) && value.every((item) => typeof item === "string"), `${name} must be a string array`);
  return value;
}

function signalMetrics(value: unknown, name: string, sampleRate: number): SignalMetrics {
  const metrics = record(value, name);
  const samples = finiteNumber(metrics.samples, `${name}.samples`);
  const durationSeconds = finiteNumber(metrics.durationSeconds, `${name}.durationSeconds`);
  const peak = finiteNumber(metrics.peak, `${name}.peak`);
  const rms = finiteNumber(metrics.rms, `${name}.rms`);
  const initMs = finiteNumber(metrics.initMs, `${name}.initMs`);
  const synthesisMs = finiteNumber(metrics.synthesisMs, `${name}.synthesisMs`);

  check(Number.isInteger(samples) && samples > 1_000 && samples < 480_000, `${name}.samples is out of range`);
  check(Math.abs(durationSeconds - samples / sampleRate) < 1e-9, `${name}.durationSeconds does not match its sample count`);
  check(peak > 0.00001 && peak <= 1.1, `${name}.peak is silent or out of range`);
  check(rms > 0.00001 && rms <= peak + 1e-9, `${name}.rms is silent or exceeds its peak`);
  check(initMs >= 0, `${name}.initMs must not be negative`);
  check(synthesisMs >= 0, `${name}.synthesisMs must not be negative`);

  return { samples, durationSeconds, peak, rms, initMs, synthesisMs };
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function verifyWav(wav: Uint8Array, metrics: SignalMetrics, sampleRate: number): void {
  check(wav.byteLength === 44 + metrics.samples * 2, "WAV byte length does not match the reported sample count");
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  check(ascii(wav, 0, 4) === "RIFF", "WAV is missing its RIFF signature");
  check(view.getUint32(4, true) === wav.byteLength - 8, "WAV RIFF size is incorrect");
  check(ascii(wav, 8, 4) === "WAVE", "WAV is missing its WAVE signature");
  check(ascii(wav, 12, 4) === "fmt ", "WAV is missing its fmt chunk");
  check(view.getUint32(16, true) === 16, "WAV fmt chunk has an unexpected size");
  check(view.getUint16(20, true) === 1, "WAV is not PCM16");
  check(view.getUint16(22, true) === 1, "WAV is not mono");
  check(view.getUint32(24, true) === sampleRate, "WAV sample rate does not match the metrics");
  check(view.getUint32(28, true) === sampleRate * 2, "WAV byte rate is incorrect");
  check(view.getUint16(32, true) === 2, "WAV block alignment is incorrect");
  check(view.getUint16(34, true) === 16, "WAV bit depth is not 16-bit");
  check(ascii(wav, 36, 4) === "data", "WAV is missing its data chunk");
  check(view.getUint32(40, true) === metrics.samples * 2, "WAV data size does not match the reported sample count");

  let peak = 0;
  let energy = 0;
  for (let index = 0; index < metrics.samples; index += 1) {
    const encoded = view.getInt16(44 + index * 2, true);
    const sample = encoded < 0 ? encoded / 0x8000 : encoded / 0x7fff;
    peak = Math.max(peak, Math.abs(sample));
    energy += sample * sample;
  }
  const rms = Math.sqrt(energy / metrics.samples);
  check(peak > 0.00001 && rms > 0.00001, "WAV payload is silent");
  check(Math.abs(peak - metrics.peak) < 0.00005, "WAV peak does not match the reported cold-run peak");
  check(Math.abs(rms - metrics.rms) < 0.00005, "WAV RMS does not match the reported cold-run RMS");
}

export function verifyReactNativeSmokeArtifacts(
  rawMetrics: unknown,
  wav: Uint8Array,
  expectedPlatform: NativePlatform,
): void {
  const metrics = record(rawMetrics, "metrics");
  check(metrics.status === "PASS", "status is not PASS");
  check(metrics.platform === expectedPlatform, `platform is not ${expectedPlatform}`);
  check(metrics.runtime === "react-native", "runtime is not react-native");
  check(metrics.native === true, "native capability is not true");

  const providers = stringArray(metrics.executionProviders, "executionProviders");
  check(providers.includes("cpu"), "CPU execution provider was not reported");
  const sampleRate = finiteNumber(metrics.sampleRate, "sampleRate");
  check(sampleRate === 24_000, "sample rate is not 24000 Hz");

  const coldDownloads = stringArray(metrics.coldDownloads, "coldDownloads").slice().sort();
  check(
    JSON.stringify(coldDownloads) === JSON.stringify(REQUIRED_COLD_DOWNLOADS),
    "cold run did not download exactly the required pinned assets",
  );
  check(stringArray(metrics.warmDownloads, "warmDownloads").length === 0, "warm cache run performed a download");

  const cold = signalMetrics(metrics.cold, "cold", sampleRate);
  const warm = signalMetrics(metrics.warm, "warm", sampleRate);
  check(warm.samples === cold.samples, "warm sample count differs from the cold run");
  check(Math.abs(warm.rms - cold.rms) < 0.00001, "warm audio RMS differs from the cold run");
  check(typeof metrics.wavPath === "string" && metrics.wavPath.length > 0, "wavPath is missing");
  check(typeof metrics.resultPath === "string" && metrics.resultPath.length > 0, "resultPath is missing");

  verifyWav(wav, cold, sampleRate);
}

async function main(): Promise<void> {
  const [platform, resultPath, wavPath] = process.argv.slice(2);
  check(platform === "ios" || platform === "android", "usage: verify_react_native_smoke_artifacts.ts <ios|android> <result.json> <audio.wav>");
  check(Boolean(resultPath) && Boolean(wavPath), "both result and WAV paths are required");
  const [rawJson, wav] = await Promise.all([
    readFile(resolve(resultPath), "utf8"),
    readFile(resolve(wavPath)),
  ]);
  verifyReactNativeSmokeArtifacts(JSON.parse(rawJson) as unknown, wav, platform);
  process.stdout.write(`Verified ${platform} React Native smoke artifacts (${wav.byteLength} WAV bytes).\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
