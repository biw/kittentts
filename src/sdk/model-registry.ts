import type { KittenTtsModelId } from "./contracts.js";

export interface KittenTtsModelDefinition {
  id: KittenTtsModelId;
  repoId: string;
  revision: string;
  modelFilename: string;
  voicesFilename: string;
  approximateBytes: number;
  modelBytes: number;
  voicesBytes: number;
  parameters: number;
  quantization: "fp32" | "int8";
  modelSha256: string;
  voicesSha256: string;
  configSha256: string;
}

export const KITTENTTS_MODELS: Readonly<Record<KittenTtsModelId, KittenTtsModelDefinition>> = {
  nano: {
    id: "nano",
    repoId: "KittenML/kitten-tts-nano-0.8-fp32",
    revision: "7a1db645b1f3ab9420761d87428e042b9cec3f26",
    modelFilename: "kitten_tts_nano_v0_8.onnx",
    voicesFilename: "voices.npz",
    approximateBytes: 56_000_000,
    modelBytes: 56_767_095,
    voicesBytes: 3_278_902,
    parameters: 15_000_000,
    quantization: "fp32",
    modelSha256: "320564d2615f235de972ca27a7f39551c94185cfa24ca85b07a29084135f1e5e",
    voicesSha256: "8aa7cee235abb0739cb51e6559685f65a4dacd95568833d05699b1633f519b3f",
    configSha256: "b66006ccbeccd4de5fc3c9272059c47f5725df7215fd889785c03602652fab64",
  },
  "nano-int8": {
    id: "nano-int8",
    repoId: "KittenML/kitten-tts-nano-0.8-int8",
    revision: "84781d74e29ee25217551556398b42f80593a813",
    modelFilename: "kitten_tts_nano_v0_8.onnx",
    voicesFilename: "voices.npz",
    approximateBytes: 25_000_000,
    modelBytes: 24_369_971,
    voicesBytes: 3_278_902,
    parameters: 15_000_000,
    quantization: "int8",
    modelSha256: "f7b0afcbee92870b32b8e0276d855b954dc25470c9f051b376ac7eee537c76fc",
    voicesSha256: "8aa7cee235abb0739cb51e6559685f65a4dacd95568833d05699b1633f519b3f",
    configSha256: "b66006ccbeccd4de5fc3c9272059c47f5725df7215fd889785c03602652fab64",
  },
  micro: {
    id: "micro",
    repoId: "KittenML/kitten-tts-micro-0.8",
    revision: "1ccf72b2c2048fd17efac7de2fab32d10e225084",
    modelFilename: "kitten_tts_micro_v0_8.onnx",
    voicesFilename: "voices.npz",
    approximateBytes: 41_000_000,
    modelBytes: 41_384_970,
    voicesBytes: 3_278_902,
    parameters: 40_000_000,
    quantization: "fp32",
    modelSha256: "95481626fee1ba70ce683e69c534fc7cb38433c46ce42d3abbeafb4b9f1a4123",
    voicesSha256: "112710c1be8ad0e967c190fb0fd95cbe5848ec4791b93209f20b28b7da20dac1",
    configSha256: "1f0bd2208348f9211cb0da64fcd1536eb28228571cc6b09e767eb6e203a0a532",
  },
  mini: {
    id: "mini",
    repoId: "KittenML/kitten-tts-mini-0.8",
    revision: "c02725660cea441db4c383af69f1f26f5cd00947",
    modelFilename: "kitten_tts_mini_v0_8.onnx",
    voicesFilename: "voices.npz",
    approximateBytes: 80_000_000,
    modelBytes: 78_268_016,
    voicesBytes: 3_278_902,
    parameters: 80_000_000,
    quantization: "fp32",
    modelSha256: "0f5bbae4fc4800c98dbc544a87ecfa79510de2fb8222db30d12e5bfe9177df91",
    voicesSha256: "40ad2638952b77b7b2f30127e2608e169fc69dd256b53bd8aaa3409a33193c42",
    configSha256: "6b160bc9b19e24ecb21e84bc14f8a7da21fdf47ec72d42450bc5cf514b61804a",
  },
};

export function resolveKittenTtsModel(model: KittenTtsModelId = "nano"): KittenTtsModelDefinition {
  const definition = KITTENTTS_MODELS[model];
  if (!definition) throw new Error(`unsupported KittenTTS model '${String(model)}'`);
  return definition;
}
