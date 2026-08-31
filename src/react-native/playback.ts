import { encodeWav } from "../audio/index.js";
import type { KittenTtsAudioPlayer } from "../sdk/contracts.js";
import { uint8ArrayToBase64 } from "../audio/base64.js";
import { loadReactNativeFileSystem, type ReactNativeFileSystem } from "./types.js";

export interface ReactNativeFilePlayer {
  playFile(filePath: string, signal?: AbortSignal): Promise<void>;
  stop(): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export interface ReactNativePlaybackOptions {
  fileSystem?: ReactNativeFileSystem;
  cacheDir?: string;
}

interface ExpoAudioStatus {
  didJustFinish?: boolean;
  mediaServicesDidReset?: boolean;
  playing?: boolean;
}

interface ExpoAudioSubscription {
  remove(): void;
}

interface ExpoAudioPlayerInstance {
  play(): void;
  pause(): void;
  remove(): void;
  addListener(
    eventName: "playbackStatusUpdate",
    listener: (status: ExpoAudioStatus) => void,
  ): ExpoAudioSubscription;
}

export interface ExpoAudioModule {
  setAudioModeAsync?(mode: { playsInSilentMode?: boolean }): Promise<unknown>;
  createAudioPlayer(
    source: { uri: string },
    options?: { updateInterval?: number; keepAudioSessionActive?: boolean },
  ): ExpoAudioPlayerInstance;
}

interface ReactNativeSoundInstance {
  play(callback: (success: boolean) => void): void;
  stop(): void;
  release(): void;
}

export interface ReactNativeSoundConstructor {
  new(filePath: string, basePath: string, callback: (error: Error | null) => void): ReactNativeSoundInstance;
  setCategory?(category: string): void;
}

let playbackSequence = 0;

async function deleteIfExists(fileSystem: ReactNativeFileSystem, filePath: string): Promise<void> {
  if (await fileSystem.exists(filePath)) await fileSystem.unlink(filePath);
}

class ReactNativeWavAudioPlayer implements KittenTtsAudioPlayer {
  readonly #filePlayer: ReactNativeFilePlayer;
  readonly #options: ReactNativePlaybackOptions;
  #activePlay = 0;

  constructor(filePlayer: ReactNativeFilePlayer, options: ReactNativePlaybackOptions) {
    this.#filePlayer = filePlayer;
    this.#options = options;
  }

  async play(audio: Float32Array, sampleRate: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.stop();
    const fileSystem = this.#options.fileSystem ?? await loadReactNativeFileSystem();
    const playId = ++playbackSequence;
    this.#activePlay = playId;
    const cacheDir = this.#options.cacheDir ?? fileSystem.CachesDirectoryPath;
    await fileSystem.mkdir(cacheDir);
    const filePath = `${cacheDir.replace(/\/+$/g, "")}/kittentts-playback-${Date.now()}-${playId}.wav`;
    try {
      await fileSystem.writeFile(filePath, uint8ArrayToBase64(encodeWav(audio, { sampleRate })), "base64");
      signal?.throwIfAborted();
      await this.#filePlayer.playFile(filePath, signal);
    } finally {
      if (this.#activePlay === playId) this.#activePlay = 0;
      await deleteIfExists(fileSystem, filePath);
    }
  }

  async stop(): Promise<void> {
    this.#activePlay = 0;
    await this.#filePlayer.stop();
  }

  async dispose(): Promise<void> {
    await this.stop();
    await this.#filePlayer.dispose?.();
  }
}

export function createReactNativeFileAudioPlayer(
  filePlayer: ReactNativeFilePlayer,
  options: ReactNativePlaybackOptions = {},
): KittenTtsAudioPlayer {
  return new ReactNativeWavAudioPlayer(filePlayer, options);
}

export function createExpoAudioPlayer(
  audioModule: ExpoAudioModule,
  options: ReactNativePlaybackOptions = {},
): KittenTtsAudioPlayer {
  type PlaybackState = {
    player: ExpoAudioPlayerInstance;
    subscription: ExpoAudioSubscription | null;
    resolve: (() => void) | null;
    reject: ((error: Error) => void) | null;
    signal?: AbortSignal;
    onAbort?: () => void;
    settled: boolean;
  };
  let current: PlaybackState | null = null;

  const finish = (state: PlaybackState, error?: Error) => {
    if (state.settled) return;
    state.settled = true;
    if (state.signal && state.onAbort) state.signal.removeEventListener("abort", state.onAbort);
    try { state.subscription?.remove(); } catch { /* non-fatal native cleanup */ }
    try { state.player.remove(); } catch { /* non-fatal native cleanup */ }
    if (current === state) current = null;
    if (error) state.reject?.(error);
    else state.resolve?.();
  };

  const stopCurrent = () => {
    const state = current;
    if (!state) return;
    try { state.player.pause(); } catch { /* non-fatal native cleanup */ }
    finish(state);
  };

  const filePlayer: ReactNativeFilePlayer = {
    async playFile(filePath, signal) {
      stopCurrent();
      signal?.throwIfAborted();
      await audioModule.setAudioModeAsync?.({ playsInSilentMode: true });
      const player = audioModule.createAudioPlayer(
        { uri: `file://${filePath}` },
        { updateInterval: 100, keepAudioSessionActive: false },
      );
      await new Promise<void>((resolve, reject) => {
        const state: PlaybackState = {
          player,
          subscription: null,
          resolve,
          reject,
          signal,
          settled: false,
        };
        current = state;
        state.onAbort = () => {
          try { player.pause(); } catch { /* non-fatal native cleanup */ }
          finish(state, signal?.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError"));
        };
        signal?.addEventListener("abort", state.onAbort, { once: true });
        state.subscription = player.addListener("playbackStatusUpdate", (status) => {
          if (status.mediaServicesDidReset) finish(state, new Error("iOS media services were reset"));
          else if (status.didJustFinish) finish(state);
        });
        try { player.play(); } catch (error) {
          finish(state, error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    async stop() { stopCurrent(); },
  };
  return createReactNativeFileAudioPlayer(filePlayer, options);
}

export function createReactNativeSoundPlayer(
  Sound: ReactNativeSoundConstructor,
  options: ReactNativePlaybackOptions = {},
): KittenTtsAudioPlayer {
  type PlaybackState = {
    sound: ReactNativeSoundInstance | null;
    resolve: () => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
    settled: boolean;
  };
  let current: PlaybackState | null = null;
  Sound.setCategory?.("Playback");

  const finish = (state: PlaybackState, error?: Error) => {
    if (state.settled) return;
    state.settled = true;
    if (state.signal && state.onAbort) state.signal.removeEventListener("abort", state.onAbort);
    if (current === state) current = null;
    if (error) state.reject(error);
    else state.resolve();
  };

  const stopState = (state: PlaybackState, error?: Error) => {
    const sound = state.sound;
    state.sound = null;
    if (sound) {
      try { sound.stop(); } catch { /* non-fatal native cleanup */ }
      try { sound.release(); } catch { /* non-fatal native cleanup */ }
    }
    finish(state, error);
  };

  const stopCurrent = (error?: Error) => {
    if (current) stopState(current, error);
  };

  const filePlayer: ReactNativeFilePlayer = {
    async playFile(filePath, signal) {
      stopCurrent();
      signal?.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const state: PlaybackState = {
          sound: null,
          resolve,
          reject,
          signal,
          settled: false,
        };
        current = state;
        state.onAbort = () => {
          stopCurrent(signal?.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError"));
        };
        signal?.addEventListener("abort", state.onAbort, { once: true });
        const sound = new Sound(filePath, "", (error) => {
          // Native implementations invoke this asynchronously, but deferring
          // also makes synchronous test doubles safe after constructor return.
          Promise.resolve().then(() => {
            if (state.settled) return;
            if (error) {
              stopState(state, error);
              return;
            }
            const loadedSound = state.sound;
            if (!loadedSound) {
              finish(state, new Error("sound loaded without a native playback instance"));
              return;
            }
            try {
              loadedSound.play((success) => {
                if (state.settled) return;
                state.sound = null;
                try { loadedSound.release(); } catch { /* non-fatal native cleanup */ }
                if (success) finish(state);
                else finish(state, new Error("playback ended early"));
              });
            } catch (playError) {
              stopState(state, playError instanceof Error ? playError : new Error(String(playError)));
            }
          });
        });
        state.sound = sound;
        if (state.settled) {
          try { sound.stop(); } catch { /* non-fatal native cleanup */ }
          try { sound.release(); } catch { /* non-fatal native cleanup */ }
          state.sound = null;
        }
      });
    },
    async stop() { stopCurrent(); },
  };
  return createReactNativeFileAudioPlayer(filePlayer, options);
}
