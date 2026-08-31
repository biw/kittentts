import { useEffect, useState } from "react";
import { Button, SafeAreaView, StyleSheet, Text, TextInput, View } from "react-native";
import * as ExpoAudio from "expo-audio";
import { KittenTTS, createExpoAudioPlayer } from "@biwills/kittentts/react-native";

type Runtime = Awaited<ReturnType<typeof KittenTTS.create>>;

export default function App() {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [text, setText] = useState("KittenTTS is speaking from this device.");
  const [status, setStatus] = useState("Loading model…");

  useEffect(() => {
    let active = true;
    let created: Runtime | null = null;

    KittenTTS.create({
      model: "nano-int8",
      player: createExpoAudioPlayer(ExpoAudio),
      onProgress: (event) => {
        if (active) setStatus(event.phase);
      },
    }).then((value) => {
      created = value;
      if (active) {
        setRuntime(value);
        setStatus("Ready");
      } else {
        value.dispose().catch(() => {});
      }
    }).catch((error: unknown) => {
      if (active) setStatus(error instanceof Error ? error.message : String(error));
    });

    return () => {
      active = false;
      created?.dispose().catch(() => {});
    };
  }, []);

  const speak = async () => {
    if (!runtime) return;
    setStatus("Synthesizing…");
    try {
      await runtime.speak(text);
      setStatus("Ready");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.card}>
        <Text style={styles.title}>KittenTTS</Text>
        <TextInput
          multiline
          onChangeText={setText}
          style={styles.input}
          value={text}
        />
        <Button disabled={!runtime} onPress={speak} title="Speak" />
        <Text style={styles.status}>{status}</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: "center", padding: 24 },
  card: { gap: 16 },
  title: { fontSize: 32, fontWeight: "700" },
  input: { minHeight: 120, borderWidth: 1, borderRadius: 12, padding: 12, textAlignVertical: "top" },
  status: { color: "#555" },
});
