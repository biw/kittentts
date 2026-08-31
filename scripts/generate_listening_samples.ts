import { verifyNodeRuntime } from "../tests-js/verification/node-runtime.js";

const listeningDir = process.argv[2] ?? ".context/listening-samples";
if (process.argv.length > 3) {
  throw new Error("usage: tsx scripts/generate_listening_samples.ts [output-dir]");
}

verifyNodeRuntime({ listeningDir }).catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
