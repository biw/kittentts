import type {
  KittenTtsAudioPlayer,
  KittenTtsBackend,
  KittenTtsCapabilities,
  KittenTtsGenerateOptions,
  KittenTtsModelId,
} from "./contracts.js";
import { abortable, throwIfAborted } from "./contracts.js";
import { KittenTtsResult } from "./result.js";
import { chunkText, preprocessForTts } from "../core/text-preprocess.js";

export interface KittenTtsSessionOptions {
  model: KittenTtsModelId;
  defaultVoice?: string;
  speed?: number;
  player?: KittenTtsAudioPlayer;
}

export class KittenTtsSession {
  readonly #backend: KittenTtsBackend;
  readonly #model: KittenTtsModelId;
  readonly #defaultVoice: string;
  readonly #speed: number;
  readonly #player?: KittenTtsAudioPlayer;
  #disposed = false;

  constructor(backend: KittenTtsBackend, options: KittenTtsSessionOptions) {
    this.#backend = backend;
    this.#model = options.model;
    this.#defaultVoice = options.defaultVoice ?? "Bella";
    this.#speed = options.speed ?? 1;
    this.#player = options.player;
  }

  get model(): KittenTtsModelId {
    return this.#model;
  }

  capabilities(): KittenTtsCapabilities {
    return { ...this.#backend.capabilities, executionProviders: [...this.#backend.capabilities.executionProviders] };
  }

  async generate(text: string, options: KittenTtsGenerateOptions = {}): Promise<KittenTtsResult> {
    this.#assertReady();
    throwIfAborted(options.signal);
    options.onProgress?.({ phase: "preprocessing" });
    const result = await abortable(
      this.#backend.synthesize({
        text,
        voice: options.voice ?? this.#defaultVoice,
        speed: options.speed ?? this.#speed,
        cleanText: options.cleanText ?? true,
        signal: options.signal,
      }),
      options.signal,
    );
    throwIfAborted(options.signal);
    options.onProgress?.({ phase: "complete", progress: 1 });
    return new KittenTtsResult(result);
  }

  async *generateStream(text: string, options: KittenTtsGenerateOptions = {}): AsyncGenerator<import("./contracts.js").KittenTtsStreamChunk> {
    this.#assertReady();
    if (typeof text !== "string" || !text.trim()) throw new Error("text must contain at least one non-whitespace character");
    const cleanedText = (options.cleanText ?? true) ? preprocessForTts(text) : text;
    const chunks = chunkText(cleanedText);
    for (let index = 0; index < chunks.length; index += 1) {
      throwIfAborted(options.signal);
      options.onProgress?.({ phase: "synthesizing", progress: index / chunks.length, detail: `chunk ${index + 1}/${chunks.length}` });
      const result = await this.generate(chunks[index], { ...options, cleanText: false, onProgress: undefined });
      yield { index, text: chunks[index], isLast: index === chunks.length - 1, result };
    }
    options.onProgress?.({ phase: "complete", progress: 1 });
  }

  async speak(text: string, options: KittenTtsGenerateOptions = {}): Promise<KittenTtsResult> {
    if (!this.#player) throw new Error("speak() requires an audio player");
    const result = await this.generate(text, options);
    await abortable(this.#player.play(result.audio, result.sampleRate, options.signal), options.signal);
    return result;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.#backend.release();
    await this.#player?.dispose?.();
  }

  async release(): Promise<void> {
    await this.dispose();
  }

  #assertReady(): void {
    if (this.#disposed) throw new Error("KittenTTS session has been disposed");
  }
}
