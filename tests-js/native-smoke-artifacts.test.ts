import assert from "node:assert/strict";
import { test } from "vitest";
import { verifyReactNativeSmokeArtifacts } from "../scripts/verify_react_native_smoke_artifacts.js";
import { encodeWav } from "../src/audio/index.js";

const COLD_DOWNLOADS = [
  "config.json",
  "kitten_tts_nano_v0_8.onnx",
  "phonemizer-list",
  "phonemizer-rules",
  "voices.npz",
];

function passingArtifacts(platform: "android" | "ios" = "ios") {
  const audio = Float32Array.from({ length: 1_200 }, (_, index) => Math.sin(index / 20) * 0.25);
  let peak = 0;
  let energy = 0;
  for (const sample of audio) {
    peak = Math.max(peak, Math.abs(sample));
    energy += sample * sample;
  }
  const signal = {
    samples: audio.length,
    durationSeconds: audio.length / 24_000,
    peak,
    rms: Math.sqrt(energy / audio.length),
  };
  return {
    metrics: {
      status: "PASS",
      platform,
      runtime: "react-native",
      native: true,
      executionProviders: ["cpu"],
      sampleRate: 24_000,
      coldDownloads: COLD_DOWNLOADS,
      warmDownloads: [] as string[],
      cold: { ...signal, initMs: 10, synthesisMs: 20 },
      warm: { ...signal, initMs: 5, synthesisMs: 20 },
      wavPath: "/device/native-smoke.wav",
      resultPath: "/device/native-smoke-result.json",
    },
    wav: encodeWav(audio, { sampleRate: 24_000 }),
  };
}

test("accepts internally consistent iOS and Android native smoke evidence", () => {
  for (const platform of ["ios", "android"] as const) {
    const { metrics, wav } = passingArtifacts(platform);
    assert.doesNotThrow(() => verifyReactNativeSmokeArtifacts(metrics, wav, platform));
  }
});

test("rejects native smoke metrics that do not prove the cold and warm paths", () => {
  const missingColdAsset = passingArtifacts();
  missingColdAsset.metrics.coldDownloads = COLD_DOWNLOADS.slice(1);
  assert.throws(
    () => verifyReactNativeSmokeArtifacts(missingColdAsset.metrics, missingColdAsset.wav, "ios"),
    /cold run did not download exactly/,
  );

  const warmDownload = passingArtifacts();
  warmDownload.metrics.warmDownloads = ["config.json"];
  assert.throws(
    () => verifyReactNativeSmokeArtifacts(warmDownload.metrics, warmDownload.wav, "ios"),
    /warm cache run performed a download/,
  );

  const divergentWarmRun = passingArtifacts();
  divergentWarmRun.metrics.warm.rms += 0.01;
  assert.throws(
    () => verifyReactNativeSmokeArtifacts(divergentWarmRun.metrics, divergentWarmRun.wav, "ios"),
    /warm audio RMS differs/,
  );
});

test("rejects missing, malformed, silent, or inconsistent WAV evidence", () => {
  const truncated = passingArtifacts();
  assert.throws(
    () => verifyReactNativeSmokeArtifacts(truncated.metrics, truncated.wav.subarray(0, -2), "ios"),
    /WAV byte length/,
  );

  const silent = passingArtifacts();
  silent.wav.fill(0, 44);
  assert.throws(
    () => verifyReactNativeSmokeArtifacts(silent.metrics, silent.wav, "ios"),
    /WAV payload is silent/,
  );

  const wrongPlatform = passingArtifacts("ios");
  assert.throws(
    () => verifyReactNativeSmokeArtifacts(wrongPlatform.metrics, wrongPlatform.wav, "android"),
    /platform is not android/,
  );
});
