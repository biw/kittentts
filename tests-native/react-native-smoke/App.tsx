import React, {useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as RNFS from '@dr.pogodin/react-native-fs';
import {KittenTTS, type KittenTtsProgress} from '@biwills/kittentts/react-native';

const ASSET_PORT = 9123;
const ASSET_HOST = Platform.OS === 'android' ? '10.0.2.2' : '127.0.0.1';
const ONLINE_ORIGIN = `http://${ASSET_HOST}:${ASSET_PORT}/`;
const OFFLINE_ORIGIN = `http://${ASSET_HOST}:9124/`;
const REPO_ID = 'KittenML/native-smoke';
const REVISION = 'native-smoke-v1';
const PHRASE = 'Kitten T T S works on this device.';
const MODEL_FILENAME = 'kitten_tts_nano_v0_8.onnx';

const INTEGRITY = {
  'config.json': 'b66006ccbeccd4de5fc3c9272059c47f5725df7215fd889785c03602652fab64',
  [MODEL_FILENAME]: 'f7b0afcbee92870b32b8e0276d855b954dc25470c9f051b376ac7eee537c76fc',
  'voices.npz': '8aa7cee235abb0739cb51e6559685f65a4dacd95568833d05699b1633f519b3f',
};
const RULES_SHA256 = '8e75e9341ea735cc514b29a7d3a95c6c241c1cc176ad43e5699b8f7f66ab3194';
const LIST_SHA256 = '24eb79018ed6253c10682096de672ce9265c1fe15c3e19e7f754d57a0fcd9790';

type SmokeState = 'IDLE' | 'RUNNING' | 'PASS' | 'FAIL';

type SignalMetrics = {
  samples: number;
  durationSeconds: number;
  peak: number;
  rms: number;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function elapsed(start: number): number {
  return Date.now() - start;
}

export function inspectSignal(audio: Float32Array, sampleRate: number): SignalMetrics {
  assert(sampleRate === 24_000, `expected 24000 Hz, got ${sampleRate}`);
  assert(audio.length > 1_000 && audio.length < 480_000, `unexpected sample count: ${audio.length}`);
  let peak = 0;
  let energy = 0;
  for (const sample of audio) {
    assert(Number.isFinite(sample), 'audio contains a non-finite sample');
    peak = Math.max(peak, Math.abs(sample));
    energy += sample * sample;
  }
  const rms = Math.sqrt(energy / audio.length);
  assert(peak > 0.00001 && peak <= 1.1, `unexpected peak amplitude: ${peak}`);
  assert(rms > 0.00001, `unexpected RMS amplitude: ${rms}`);
  return {
    samples: audio.length,
    durationSeconds: audio.length / sampleRate,
    peak,
    rms,
  };
}

function assertWavHeader(wav: Uint8Array): void {
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...wav.slice(offset, offset + length));
  assert(wav.length > 44, 'WAV output has no audio payload');
  assert(ascii(0, 4) === 'RIFF', 'WAV output is missing RIFF header');
  assert(ascii(8, 4) === 'WAVE', 'WAV output is missing WAVE header');
}

function runtimeOptions(origin: string, onDownload: (asset: string) => void) {
  const cacheRoot = `${RNFS.CachesDirectoryPath}/kittentts-native-smoke/models`;
  const phonemizerCache = `${RNFS.CachesDirectoryPath}/kittentts-native-smoke/phonemizer`;
  return {
    model: 'nano-int8' as const,
    repoId: REPO_ID,
    revision: REVISION,
    repoBaseUrl: origin,
    cacheDir: cacheRoot,
    integrity: INTEGRITY,
    retries: 0,
    phonemizerOptions: {
      cacheDir: phonemizerCache,
      rulesUrl: `${origin}en_rules`,
      listUrl: `${origin}en_list`,
      rulesSha256: RULES_SHA256,
      listSha256: LIST_SHA256,
      retries: 0,
    },
    onDownloadProgress: (asset: string) => onDownload(asset),
  };
}

async function runNativeSmoke(
  reportProgress: (event: KittenTtsProgress) => void,
): Promise<Record<string, unknown>> {
  const smokeCache = `${RNFS.CachesDirectoryPath}/kittentts-native-smoke`;
  if (await RNFS.exists(smokeCache)) {
    await RNFS.unlink(smokeCache);
  }

  const coldDownloads = new Set<string>();
  const coldStart = Date.now();
  const coldRuntime = await KittenTTS.create({
    ...runtimeOptions(ONLINE_ORIGIN, asset => coldDownloads.add(asset)),
    onProgress: reportProgress,
  });
  const coldInitMs = elapsed(coldStart);
  const capabilities = coldRuntime.capabilities();
  assert(capabilities.runtime === 'react-native', `unexpected runtime: ${capabilities.runtime}`);
  assert(capabilities.native, 'native capability is false');
  assert(coldDownloads.has('config.json'), 'cold run did not download config.json');
  assert(coldDownloads.has(MODEL_FILENAME), 'cold run did not download the ONNX model');
  assert(coldDownloads.has('voices.npz'), 'cold run did not download voices.npz');
  assert(coldDownloads.has('phonemizer-rules'), 'cold run did not download phonemizer rules');
  assert(coldDownloads.has('phonemizer-list'), 'cold run did not download phonemizer list');

  let coldResult;
  let coldSynthesisMs: number;
  try {
    const started = Date.now();
    coldResult = await coldRuntime.generate(PHRASE, {onProgress: reportProgress});
    coldSynthesisMs = elapsed(started);
  } finally {
    await coldRuntime.dispose();
  }
  const coldSignal = inspectSignal(coldResult.audio, coldResult.sampleRate);
  const wav = coldResult.wavData();
  assertWavHeader(wav);

  const warmDownloads = new Set<string>();
  const warmStart = Date.now();
  const warmRuntime = await KittenTTS.create({
    ...runtimeOptions(OFFLINE_ORIGIN, asset => warmDownloads.add(asset)),
    onProgress: reportProgress,
  });
  const warmInitMs = elapsed(warmStart);
  let warmResult;
  let warmSynthesisMs: number;
  try {
    const started = Date.now();
    warmResult = await warmRuntime.generate(PHRASE, {onProgress: reportProgress});
    warmSynthesisMs = elapsed(started);
  } finally {
    await warmRuntime.dispose();
  }
  const warmSignal = inspectSignal(warmResult.audio, warmResult.sampleRate);
  assert(warmDownloads.size === 0, `warm run unexpectedly downloaded: ${[...warmDownloads].join(', ')}`);
  assert(warmSignal.samples === coldSignal.samples, 'warm sample count differs from cold run');
  assert(Math.abs(warmSignal.rms - coldSignal.rms) < 0.00001, 'warm audio differs from cold run');

  const wavPath = `${RNFS.DocumentDirectoryPath}/native-smoke.wav`;
  const resultPath = `${RNFS.DocumentDirectoryPath}/native-smoke-result.json`;
  await RNFS.writeFile(wavPath, coldResult.wavBase64(), 'base64');

  const metrics = {
    status: 'PASS',
    platform: Platform.OS,
    runtime: capabilities.runtime,
    native: capabilities.native,
    executionProviders: capabilities.executionProviders,
    sampleRate: coldResult.sampleRate,
    coldDownloads: [...coldDownloads].sort(),
    warmDownloads: [...warmDownloads],
    cold: {...coldSignal, initMs: coldInitMs, synthesisMs: coldSynthesisMs},
    warm: {...warmSignal, initMs: warmInitMs, synthesisMs: warmSynthesisMs},
    wavPath,
    resultPath,
  };
  await RNFS.writeFile(resultPath, `${JSON.stringify(metrics, null, 2)}\n`, 'utf8');
  return metrics;
}

export default function App() {
  const mounted = useRef(true);
  const [state, setState] = useState<SmokeState>('IDLE');
  const [phase, setPhase] = useState('Ready to run');
  const [details, setDetails] = useState('');

  useEffect(() => () => {
    mounted.current = false;
  }, []);

  const run = async () => {
    if (state === 'RUNNING') {
      return;
    }
    setState('RUNNING');
    setPhase('Starting cold run');
    setDetails('');
    try {
      const metrics = await runNativeSmoke(event => {
        if (mounted.current) {
          setPhase(event.detail ? `${event.phase}: ${event.detail}` : event.phase);
        }
      });
      if (mounted.current) {
        setState('PASS');
        setPhase('React Native runtime: PASS');
        setDetails(JSON.stringify(metrics, null, 2));
      }
    } catch (error) {
      if (mounted.current) {
        const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
        setState('FAIL');
        setPhase('React Native runtime: FAIL');
        setDetails(message);
      }
    }
  };

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar barStyle="dark-content" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.eyebrow}>PACKED-PACKAGE DEVICE TEST</Text>
        <Text style={styles.title}>KittenTTS React Native</Text>
        <Text style={styles.description}>
          Downloads pinned fixtures, runs native ONNX synthesis, verifies the WAV,
          then repeats with an unreachable server to prove the cache works.
        </Text>
        <Pressable
          accessibilityRole="button"
          disabled={state === 'RUNNING'}
          onPress={run}
          style={({pressed}) => [styles.button, pressed && styles.buttonPressed]}
          testID="run-smoke">
          <Text style={styles.buttonText}>Run smoke test</Text>
        </Pressable>
        <View style={styles.statusCard}>
          <View style={styles.statusRow}>
            {state === 'RUNNING' ? <ActivityIndicator /> : null}
            <Text
              accessibilityLabel={`Smoke status ${state}`}
              style={[styles.status, state === 'FAIL' && styles.failure]}
              testID={`smoke-${state.toLowerCase()}`}>
              {state}
            </Text>
          </View>
          <Text style={styles.phase}>{phase}</Text>
          {details ? <Text selectable style={styles.details}>{details}</Text> : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: '#f7f4ed'},
  content: {padding: 24, gap: 16},
  eyebrow: {fontSize: 12, fontWeight: '700', letterSpacing: 1.3, color: '#6c6257'},
  title: {fontSize: 34, lineHeight: 40, fontWeight: '800', color: '#201d19'},
  description: {fontSize: 17, lineHeight: 25, color: '#554d45'},
  button: {alignItems: 'center', borderRadius: 12, padding: 16, backgroundColor: '#d6533c'},
  buttonPressed: {opacity: 0.75},
  buttonText: {fontSize: 17, fontWeight: '700', color: '#fff'},
  statusCard: {gap: 10, borderRadius: 14, padding: 18, backgroundColor: '#fff'},
  statusRow: {flexDirection: 'row', alignItems: 'center', gap: 10},
  status: {fontSize: 20, fontWeight: '800', color: '#197047'},
  failure: {color: '#ae2f2f'},
  phase: {fontSize: 15, color: '#554d45'},
  details: {fontFamily: Platform.select({ios: 'Menlo', android: 'monospace'}), fontSize: 11, color: '#201d19'},
});
