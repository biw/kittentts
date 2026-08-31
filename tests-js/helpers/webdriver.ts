import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { stopProcess } from "./process.js";

export interface WebDriverExampleOptions {
  browserName: "firefox" | "safari";
  driverCommand: string;
  driverArgs(port: number): string[];
  capabilities: Record<string, unknown>;
  executionMode?: "auto" | "wasm" | "webgpu";
  transport?: "main" | "worker";
  expectedProvider?: "wasm" | "webgpu";
  expectedThreads?: number;
  expectedSamples?: number;
  timeoutMs?: number;
}

interface WebDriverState {
  status?: string;
  result?: string;
}

interface BrowserResult {
  executionProviders: string[];
  samples: number;
  threads: number;
  transport?: string;
}

function startMacFocusGuard(browserName: WebDriverExampleOptions["browserName"]): ChildProcess | undefined {
  if (process.platform !== "darwin" || browserName !== "safari" || process.env.CI) return undefined;

  const frontmostBundleId = execFileSync(
    "osascript",
    [
      "-l",
      "JavaScript",
      "-e",
      'ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier.js',
    ],
    { encoding: "utf8" },
  ).trim();
  if (!frontmostBundleId || frontmostBundleId === "com.apple.Safari") return undefined;

  const script = `
    ObjC.import("AppKit");
    const workspace = $.NSWorkspace.sharedWorkspace;
    const preferredBundleId = ${JSON.stringify(frontmostBundleId)};
    while (true) {
      const activeBundleId = workspace.frontmostApplication.bundleIdentifier.js;
      if (activeBundleId === "com.apple.Safari") {
        const applications = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(preferredBundleId);
        if (applications.count > 0) applications.objectAtIndex(0).activateWithOptions(2);
      }
      $.NSThread.sleepForTimeInterval(0.2);
    }
  `;
  return spawn("osascript", ["-l", "JavaScript", "-e", script], {
    stdio: "ignore",
  });
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate a TCP port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function webdriver<T>(port: number, commandPath: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${commandPath}`, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = await response.json() as {
    value: T | { error: string; message: string; stacktrace?: string };
  };
  if (!response.ok || (typeof body.value === "object" && body.value && "error" in body.value)) {
    throw new Error(`WebDriver ${commandPath} failed: ${JSON.stringify(body.value)}`);
  }
  return body.value as T;
}

async function waitForHttp(url: string, timeoutMs: number, processError?: () => Error | undefined): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const error = processError?.();
    if (error) throw error;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return;
    } catch {
      // The server or driver may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${url}`);
}

export async function runWebDriverExample(options: WebDriverExampleOptions): Promise<BrowserResult> {
  const serverPort = await getFreePort();
  const driverPort = await getFreePort();
  const serverLogs: string[] = [];
  const driverLogs: string[] = [];
  const focusGuard = startMacFocusGuard(options.browserName);
  const server = spawn(process.execPath, ["scripts/serve_fixture_harness.mjs"], {
    env: { ...process.env, PORT: String(serverPort) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const driver = spawn(options.driverCommand, options.driverArgs(driverPort), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let driverError: Error | undefined;
  driver.once("error", (error) => {
    driverError = error;
  });
  server.stdout?.on("data", (chunk) => serverLogs.push(String(chunk)));
  server.stderr?.on("data", (chunk) => serverLogs.push(String(chunk)));
  driver.stdout?.on("data", (chunk) => driverLogs.push(String(chunk)));
  driver.stderr?.on("data", (chunk) => driverLogs.push(String(chunk)));

  let sessionId: string | undefined;
  try {
    await waitForHttp(`http://127.0.0.1:${serverPort}/examples/browser-basic.html`, 15_000);
    await waitForHttp(`http://127.0.0.1:${driverPort}/status`, 30_000, () => driverError);
    const session = await webdriver<{ sessionId: string }>(driverPort, "/session", {
      method: "POST",
      body: JSON.stringify({ capabilities: { alwaysMatch: options.capabilities } }),
    });
    sessionId = session.sessionId;
    const params = new URLSearchParams({
      autorun: "1",
      execution: options.executionMode ?? "wasm",
      transport: options.transport ?? "main",
      threads: String(options.expectedThreads ?? 1),
    });
    const url = `http://127.0.0.1:${serverPort}/examples/browser-basic.html?${params}`;
    await webdriver(driverPort, `/session/${sessionId}/url`, {
      method: "POST",
      body: JSON.stringify({ url }),
    });

    const deadline = Date.now() + (options.timeoutMs ?? 240_000);
    let state: WebDriverState = {};
    while (Date.now() < deadline) {
      state = await webdriver(driverPort, `/session/${sessionId}/execute/sync`, {
        method: "POST",
        body: JSON.stringify({
          script: `return {
            status: document.querySelector("#status-chip")?.textContent,
            result: document.querySelector("#result-json")?.textContent
          };`,
          args: [],
        }),
      });
      if (["pass", "fail", "script-error", "promise-error"].includes(state.status ?? "")) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }

    if (state.status !== "pass") {
      throw new Error(`browser status '${state.status ?? "timeout"}': ${state.result ?? "no result"}`);
    }
    const result = JSON.parse(state.result ?? "null") as BrowserResult;
    if (options.expectedProvider && !result.executionProviders.includes(options.expectedProvider)) {
      throw new Error(`expected ${options.expectedProvider} provider: ${state.result}`);
    }
    if (options.expectedThreads !== undefined && result.threads !== options.expectedThreads) {
      throw new Error(`expected ${options.expectedThreads} threads: ${state.result}`);
    }
    if (options.expectedSamples !== undefined && result.samples !== options.expectedSamples) {
      throw new Error(`expected ${options.expectedSamples} samples: ${state.result}`);
    }
    return result;
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.stack : String(error)}\n` +
      `serverLogs=${serverLogs.join("")}\n` +
      `driverLogs=${driverLogs.join("")}`,
    );
  } finally {
    if (sessionId) {
      await webdriver(driverPort, `/session/${sessionId}`, { method: "DELETE" }).catch(() => undefined);
    }
    await Promise.all([
      stopProcess(server),
      stopProcess(driver),
      ...(focusGuard ? [stopProcess(focusGuard)] : []),
    ]);
  }
}
