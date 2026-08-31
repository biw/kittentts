import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const BROWSER_STARTUP_TIMEOUT_MS = 30_000;
const CDP_COMMAND_TIMEOUT_MS = 15_000;

class CdpCommandTimeoutError extends Error {}

function parseArgs(argv) {
  const options = {
    url: null,
    timeoutMs: 240000,
    browserBinary: process.env.BROWSER_BIN ?? "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    executionMode: "wasm",
    enableWebGpu: false,
    pagePath: "/examples/browser-basic.html",
    staticRoot: null,
    requireProvider: null,
    useRepo: false,
    transport: "main",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--url") {
      options.url = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      options.timeoutMs = Number(argv[index + 1] ?? options.timeoutMs);
      index += 1;
      continue;
    }
    if (arg === "--browser-binary") {
      options.browserBinary = argv[index + 1] ?? options.browserBinary;
      index += 1;
      continue;
    }
    if (arg === "--execution-mode") {
      const value = argv[index + 1] ?? "wasm";
      if (value !== "auto" && value !== "wasm" && value !== "webgpu") {
        throw new Error(`unsupported execution mode '${value}'`);
      }
      options.executionMode = value;
      index += 1;
      continue;
    }
    if (arg === "--enable-webgpu") {
      options.enableWebGpu = true;
      continue;
    }
    if (arg === "--require-provider") {
      options.requireProvider = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === "--page-path") {
      options.pagePath = argv[index + 1] ?? options.pagePath;
      index += 1;
      continue;
    }
    if (arg === "--static-root") {
      options.staticRoot = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === "--repo") {
      options.useRepo = true;
      continue;
    }
    if (arg === "--transport") {
      const value = argv[index + 1] ?? "main";
      if (value !== "main" && value !== "worker") {
        throw new Error(`unsupported transport '${value}'`);
      }
      options.transport = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument '${arg}'`);
  }

  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate free port"));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) {
        return;
      }
    } catch {
      // Server not ready yet.
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for HTTP endpoint ${url}`);
}

async function waitForJson(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) {
        return response.json();
      }
    } catch {
      // Browser debug server not ready yet.
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for JSON endpoint ${url}`);
}

async function stopProcess(process, signal) {
  if (process.exitCode !== null || process.signalCode !== null) {
    return;
  }

  await new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      process.removeListener("exit", onExit);
      process.kill("SIGKILL");
      resolve();
    }, 5000);
    process.once("exit", onExit);
    process.kill(signal);
  });
}

class CdpClient {
  constructor(webSocketUrl) {
    this.socket = new WebSocket(webSocketUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.closed = false;
    this.socket.addEventListener("message", (event) => {
      const payload = JSON.parse(event.data);
      if (payload.id !== undefined) {
        const entry = this.pending.get(payload.id);
        if (!entry) {
          return;
        }
        this.pending.delete(payload.id);
        clearTimeout(entry.timeout);
        if (payload.error) {
          entry.reject(new Error(payload.error.message ?? JSON.stringify(payload.error)));
        } else {
          entry.resolve(payload.result);
        }
        return;
      }
      this.events.push(payload);
    });
    this.socket.addEventListener("close", () => {
      this.failPending(new Error("CDP connection closed"));
    });
    this.socket.addEventListener("error", (event) => {
      this.failPending(event.error ?? new Error("CDP connection failed"));
    });
  }

  async connect() {
    if (this.socket.readyState === WebSocket.OPEN) {
      return;
    }
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`CDP connection timed out after ${CDP_COMMAND_TIMEOUT_MS}ms`));
      }, CDP_COMMAND_TIMEOUT_MS);
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (event) => {
        cleanup();
        reject(event.error ?? new Error("failed to connect to CDP"));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        this.socket.removeEventListener("open", onOpen);
        this.socket.removeEventListener("error", onError);
      };
      this.socket.addEventListener("open", onOpen);
      this.socket.addEventListener("error", onError);
    });
  }

  async send(method, params = {}, timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
    if (this.closed) {
      throw new Error("CDP client already closed");
    }
    const id = this.nextId;
    this.nextId += 1;
    const payload = JSON.stringify({ id, method, params });
    const result = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpCommandTimeoutError(`CDP command '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
    });
    this.socket.send(payload);
    return result;
  }

  failPending(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timeout);
      entry.reject(error);
    }
    this.pending.clear();
  }

  drainEvents() {
    const events = [...this.events];
    this.events.length = 0;
    return events;
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.failPending(new Error("CDP client closed"));
    this.socket.close();
  }
}

function extractConsoleMessages(events) {
  return events
    .map((event) => {
      if (event.method === "Runtime.exceptionThrown") {
        return `exception: ${event.params?.exceptionDetails?.text ?? "unknown"} ${event.params?.exceptionDetails?.exception?.description ?? ""}`;
      }
      if (event.method === "Log.entryAdded") {
        return `browser-log: ${event.params?.entry?.level ?? "unknown"} ${event.params?.entry?.text ?? ""}`;
      }
      if (event.method !== "Runtime.consoleAPICalled") return "";
      const args = event.params?.args ?? [];
      return args.map((arg) => arg.value ?? arg.description ?? "").join(" ");
    })
    .filter(Boolean);
}

async function getFirstPageTarget(debugPort, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await waitForJson(`http://127.0.0.1:${debugPort}/json/list`, 5000);
    const page = targets.find((target) => target.type === "page");
    if (page?.webSocketDebuggerUrl) {
      return page.webSocketDebuggerUrl;
    }
    await sleep(250);
  }
  throw new Error("timed out waiting for a page target");
}

async function evaluateStatus(client) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => ({
      status: document.querySelector("#status-chip")?.textContent ?? null,
      resultText: document.querySelector("#result-json")?.textContent ?? null,
      title: document.title,
      href: location.href
    }))()`,
    returnByValue: true,
    awaitPromise: true,
  });
  return result.result?.value ?? {};
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const serverPort = await getFreePort();
  const debugPort = await getFreePort();
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "kittentts-brave-"));
  const browserLogs = [];
  const serverLogs = [];
  let browserExit = null;
  let browserLaunchError = null;

  const exampleUrl =
    options.url ??
    `http://127.0.0.1:${serverPort}${options.pagePath}?autorun=1&execution=${options.executionMode}&transport=${options.transport}${
      options.useRepo ? "&repo=KittenML/kitten-tts-nano-0.8" : ""
    }`;

  const serverProcess = spawn(process.execPath, ["scripts/serve_fixture_harness.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(serverPort), ...(options.staticRoot ? { STATIC_ROOT: options.staticRoot } : {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProcess.stdout.on("data", (chunk) => serverLogs.push(String(chunk)));
  serverProcess.stderr.on("data", (chunk) => serverLogs.push(String(chunk)));

  const browserArgs = [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ];
  if (options.enableWebGpu) {
    browserArgs.push("--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=swiftshader");
  } else {
    browserArgs.push("--disable-gpu");
  }
  if (process.platform === "linux") {
    // Required by some hosted Linux runners and avoids a small shared-memory mount.
    browserArgs.push("--no-sandbox", "--disable-dev-shm-usage");
  }

  const browserProcess = spawn(
    options.browserBinary,
    browserArgs,
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  browserProcess.stdout.on("data", (chunk) => browserLogs.push(String(chunk)));
  browserProcess.stderr.on("data", (chunk) => browserLogs.push(String(chunk)));
  browserProcess.once("exit", (code, signal) => {
    browserExit = { code, signal };
  });
  browserProcess.once("error", (error) => {
    browserLaunchError = error;
  });

  let client;
  try {
    const pageUrl = new URL(exampleUrl);
    await waitForHttp(`${pageUrl.origin}${pageUrl.pathname}`, 10000);
    await waitForJson(`http://127.0.0.1:${debugPort}/json/version`, BROWSER_STARTUP_TIMEOUT_MS);
    if (browserLaunchError) {
      throw browserLaunchError;
    }
    const webSocketUrl = await getFirstPageTarget(debugPort, BROWSER_STARTUP_TIMEOUT_MS);
    client = new CdpClient(webSocketUrl);
    await client.connect();
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Log.enable");
    await client.send("Page.navigate", { url: exampleUrl });

    const deadline = Date.now() + options.timeoutMs;
    let lastState = null;
    let consoleMessages = [];

    while (Date.now() < deadline) {
      await sleep(1000);
      consoleMessages = [...consoleMessages, ...extractConsoleMessages(client.drainEvents())];
      let state;
      try {
        state = await evaluateStatus(client);
      } catch (error) {
        if (error instanceof CdpCommandTimeoutError) {
          continue;
        }
        throw error;
      }
      lastState = state;
      if (state.status === "pass") {
        const result = state.resultText ? JSON.parse(state.resultText) : null;
        if (options.requireProvider && !result?.executionProviders?.includes(options.requireProvider)) {
          throw new Error(
            `browser example did not use required provider '${options.requireProvider}': ${state.resultText}`,
          );
        }
        console.log(
          JSON.stringify(
            {
              url: exampleUrl,
              status: state.status,
              result,
              consoleMessages,
            },
            null,
            2,
          ),
        );
        return;
      }
      if (["fail", "script-error", "promise-error"].includes(state.status)) {
        throw new Error(
          `browser example failed: ${state.status}\n${state.resultText ?? "(no result json)"}\n${consoleMessages.join("\n")}`,
        );
      }
    }

    throw new Error(
      `browser example timed out after ${options.timeoutMs}ms\nlastState=${JSON.stringify(lastState, null, 2)}\n` +
        `console=${consoleMessages.join("\n")}\n` +
        `serverLogs=${serverLogs.join("")}\n` +
        `browserLogs=${browserLogs.join("")}`,
    );
  } catch (error) {
    throw new Error(
      `${error.stack || String(error)}\n` +
        `browserExit=${JSON.stringify(browserExit)}\n` +
        `serverLogs=${serverLogs.join("")}\n` +
        `browserLogs=${browserLogs.join("")}`,
    );
  } finally {
    client?.close();
    await Promise.all([stopProcess(serverProcess, "SIGTERM"), stopProcess(browserProcess, "SIGTERM")]);
    await fs.rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
