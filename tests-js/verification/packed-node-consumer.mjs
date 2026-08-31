import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();

function run(
  command,
  args,
  { cwd = repoRoot, env = process.env, captureStdout = false, allowedExitCodes = [0], shell = false } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell,
      stdio: captureStdout ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    let stdout = "";
    if (captureStdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
    }
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (allowedExitCodes.includes(code)) {
        resolve(stdout);
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with ${signal ?? `exit code ${code ?? "unknown"}`}`));
    });
  });
}

function runNpm(args, options = {}) {
  return run("npm", args, { ...options, shell: process.platform === "win32" });
}

async function verifyConsumerAudit(cwd) {
  const output = await runNpm(["audit", "--omit=dev", "--json"], {
    cwd,
    captureStdout: true,
    allowedExitCodes: [0, 1],
  });
  const report = JSON.parse(output);
  const counts = report.metadata?.vulnerabilities;
  if (!counts || typeof counts.total !== "number") {
    throw new Error(`unexpected npm audit output: ${output}`);
  }
  if (counts.total === 0) {
    return counts;
  }
  throw new Error(`packed consumer has vulnerabilities: ${output}`);
}

async function createTarball() {
  const output = await runNpm(["pack", "--json", "--ignore-scripts"], { captureStdout: true });
  const parsed = JSON.parse(output);
  const candidates = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && typeof parsed.filename === "string"
      ? [parsed]
      : parsed && typeof parsed === "object"
        ? Object.values(parsed)
        : [];
  const result = candidates.length === 1 ? candidates[0] : undefined;
  if (typeof result?.filename !== "string") {
    throw new Error(`unexpected npm pack output: ${output}`);
  }
  return path.resolve(repoRoot, result.filename);
}

async function verifyTypeDeclarations(cwd) {
  await fs.writeFile(
    path.join(cwd, "typecheck.ts"),
    `import { KittenTTS, type KittenTtsOptions } from "@biwills/kittentts";

const browserOptions: KittenTtsOptions = {
  model: "nano-int8",
  transport: "worker",
  executionMode: "webgpu",
};
const nodeOptions: KittenTtsOptions = {
  model: "mini",
  cacheDir: ".cache/kittentts",
};

void KittenTTS.create(browserOptions);
void KittenTTS.create(nodeOptions);
`,
  );
  await fs.writeFile(
    path.join(cwd, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          lib: ["ES2022", "DOM"],
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ["typecheck.ts"],
      },
      null,
      2,
    )}\n`,
  );
  await run(
    process.execPath,
    [path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(cwd, "tsconfig.json")],
    { cwd },
  );
}

async function main() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kittentts-packed-consumer-"));
  let tarballPath;
  try {
    tarballPath = await createTarball();
    await fs.writeFile(
      path.join(tempDir, "package.json"),
      `${JSON.stringify({
        private: true,
        type: "module",
        overrides: {
          "adm-zip": "0.6.0",
          protobufjs: "7.6.5",
        },
      }, null, 2)}\n`,
    );
    await runNpm(["install", "--no-audit", "--no-fund", tarballPath, "onnxruntime-node@1.27.0"], {
      cwd: tempDir,
    });
    await verifyTypeDeclarations(tempDir);
    const audit = await verifyConsumerAudit(tempDir);

    const smokeTestPath = path.join(tempDir, "smoke-test.mjs");
    await fs.writeFile(
      smokeTestPath,
      `import fs from "node:fs/promises";
import { collectKittenTtsStream, KittenTTS } from "@biwills/kittentts";

const runtime = await KittenTTS.create({
  manifestPath: process.env.KITTENTTS_SMOKE_MANIFEST,
});
try {
  const manifest = JSON.parse(await fs.readFile(process.env.KITTENTTS_SMOKE_MANIFEST, "utf8"));
  let checkedChunks = 0;
  for (const fixtureCase of manifest.cases) {
    const result = await runtime.generate(fixtureCase.text, {
      voice: fixtureCase.voice,
      speed: fixtureCase.speed,
      cleanText: fixtureCase.clean_text,
    });
    if (result.sampleRate !== manifest.sample_rate || result.cleanedText !== fixtureCase.cleaned_text || result.chunks.length !== fixtureCase.chunks.length || result.audio.length !== fixtureCase.audio.num_samples) {
      throw new Error(\`packed Node parity mismatch for \${fixtureCase.id}\`);
    }
    for (let index = 0; index < result.chunks.length; index += 1) {
      const actual = result.chunks[index];
      const expected = fixtureCase.chunks[index];
      if (actual.text !== expected.text || actual.phonemesRaw !== expected.phonemes_raw || actual.audio.length !== expected.audio.num_samples || JSON.stringify(actual.inputIds) !== JSON.stringify(expected.input_ids)) {
        throw new Error(\`packed Node chunk mismatch for \${fixtureCase.id}:\${index}\`);
      }
      checkedChunks += 1;
    }
  }
  const probe = await runtime.generate("A Python-free Node package test.", { voice: "Bruno" });
  const wav = probe.wavData();
  if (wav[0] !== 82 || wav[1] !== 73 || wav[2] !== 70 || wav[3] !== 70) {
    throw new Error("packed package WAV encoder returned an invalid RIFF header");
  }
  const mp3 = await probe.mp3Data({ bitrate: 64 });
  if (mp3.length < 100) throw new Error("packed package MP3 encoder returned no MPEG data");
  const streamed = await collectKittenTtsStream(runtime.generateStream("First streamed sentence. Second streamed sentence."), { crossfadeMs: 10 });
  if (streamed.chunks.length !== 2 || streamed.audio.length === 0) throw new Error("packed package streaming returned invalid output");
  console.log(JSON.stringify({ checkedCases: manifest.cases.length, checkedChunks, sampleRate: probe.sampleRate, mp3Bytes: mp3.length, streamedChunks: streamed.chunks.length, capabilities: runtime.capabilities() }));
} finally {
  await runtime.release();
  await runtime.release();
}
`,
    );

    const runtimeEnv = {
      ...process.env,
      PATH: "",
      KITTENTTS_SMOKE_MANIFEST: path.join(repoRoot, ".context", "reference-fixtures", "manifest.json"),
    };
    const output = await run(process.execPath, [smokeTestPath], {
      cwd: tempDir,
      env: runtimeEnv,
      captureStdout: true,
    });
    console.log(
      JSON.stringify({ status: "pass", consumerDir: tempDir, audit, result: JSON.parse(output) }, null, 2),
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    if (tarballPath) {
      await fs.rm(tarballPath, { force: true });
    }
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
