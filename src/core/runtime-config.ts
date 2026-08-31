import type { FixtureManifest } from "./phoneme-feeds.js";
import type { VoiceResolutionConfig } from "./pipeline.js";

export interface KittenTtsRuntimeConfig extends VoiceResolutionConfig {
  sampleRate: number;
}

export function runtimeConfigFromManifest(manifest: FixtureManifest): KittenTtsRuntimeConfig {
  return {
    sampleRate: manifest.sample_rate,
    speedPriors: manifest.speed_priors,
    voiceAliases: manifest.voice_aliases,
  };
}
