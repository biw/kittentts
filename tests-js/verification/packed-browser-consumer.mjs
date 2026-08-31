import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();
const browserVerifier = path.join(repoRoot, "tests-js", "verification", "chrome-driver.mjs");
const consumerFixtureFiles = ["packed-browser-consumer.html", "packed-browser-consumer.mjs"];
const referenceFixtureDir = path.join(repoRoot, ".context", "reference-fixtures");
const browserCases = [
  { id: "main-auto", transport: "main", executionMode: "auto" },
  { id: "main-wasm", transport: "main", executionMode: "wasm" },
  { id: "worker-wasm", transport: "worker", executionMode: "wasm" },
];

function selectedCases(argv) {
  if (argv.length === 0) return browserCases;
  if (argv.length !== 2 || argv[0] !== "--case") {
    throw new Error("usage: verify_packed_browser_consumer.mjs [--case main-auto|main-wasm|worker-wasm]");
  }
  const selected = browserCases.find(({ id }) => id === argv[1]);
  if (!selected) throw new Error(`unknown packed browser case '${argv[1]}'`);
  return [selected];
}

function run(command, args, { cwd = repoRoot, captureStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
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
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with ${signal ?? `exit code ${code ?? "unknown"}`}`));
    });
  });
}

async function createTarball() {
  const output = await run("npm", ["pack", "--json", "--ignore-scripts"], { captureStdout: true });
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

async function main() {
  const cases = selectedCases(process.argv.slice(2));
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kittentts-packed-browser-"));
  let tarballPath;
  try {
    tarballPath = await createTarball();
    await fs.writeFile(
      path.join(tempDir, "package.json"),
      `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
    );
    await run("npm", ["install", "--no-audit", "--no-fund", tarballPath, "onnxruntime-web@1.27.0"], {
      cwd: tempDir,
    });
    await Promise.all(
      consumerFixtureFiles.map((filename) =>
        fs.copyFile(path.join(repoRoot, "web", filename), path.join(tempDir, filename)),
      ),
    );
    const fixtureDir = path.join(tempDir, "fixtures");
    await fs.mkdir(fixtureDir, { recursive: true });
    await Promise.all(
      ["manifest.json", "model.onnx", "voices.npz"].map((filename) =>
        fs.copyFile(path.join(referenceFixtureDir, filename), path.join(fixtureDir, filename)),
      ),
    );

    for (const { transport, executionMode } of cases) {
      console.log(JSON.stringify({ status: "running", transport, executionMode }));
      await run(process.execPath, [
        browserVerifier,
        "--static-root",
        tempDir,
        "--page-path",
        "/packed-browser-consumer.html",
        "--execution-mode",
        executionMode,
        "--transport",
        transport,
      ]);
    }
    console.log(JSON.stringify({ status: "pass", cases }, null, 2));
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
