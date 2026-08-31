import type { KittenTtsAudioPlayer } from "../sdk/contracts.js";

export class BrowserAudioPlayer implements KittenTtsAudioPlayer {
  #context?: AudioContext;
  #source?: AudioBufferSourceNode;

  async play(audio: Float32Array, sampleRate: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.stop();
    const AudioContextConstructor = globalThis.AudioContext;
    if (!AudioContextConstructor) throw new Error("Web Audio is not available in this browser");
    const context = this.#context ?? new AudioContextConstructor();
    this.#context = context;
    if (context.state === "suspended") await context.resume();
    const buffer = context.createBuffer(1, audio.length, sampleRate);
    buffer.copyToChannel(new Float32Array(audio), 0);
    const source = context.createBufferSource();
    this.#source = source;
    source.buffer = buffer;
    source.connect(context.destination);
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        source.stop();
        reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      source.addEventListener("ended", () => {
        signal?.removeEventListener("abort", onAbort);
        if (this.#source === source) this.#source = undefined;
        resolve();
      }, { once: true });
      source.start();
    });
  }

  stop(): void {
    if (!this.#source) return;
    const source = this.#source;
    this.#source = undefined;
    try { source.stop(); } catch { /* The source may already have ended. */ }
  }

  async dispose(): Promise<void> {
    this.stop();
    await this.#context?.close();
    this.#context = undefined;
  }
}
