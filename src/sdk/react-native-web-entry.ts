export * from "./browser-entry.js";
export { BrowserAudioPlayer } from "../browser/playback.js";

import { BrowserAudioPlayer } from "../browser/playback.js";

/** React Native Web playback helper matching the native adapter factories. */
export function createBrowserAudioPlayer(): BrowserAudioPlayer {
  return new BrowserAudioPlayer();
}
