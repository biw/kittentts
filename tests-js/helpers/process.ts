import { spawn, type ChildProcess } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  captureStdout?: boolean;
  allowedExitCodes?: number[];
}

export function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      shell: process.platform === "win32" && ["npm", "pnpm"].includes(command),
      stdio: options.captureStdout ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    let stdout = "";
    if (options.captureStdout) {
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
      });
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if ((options.allowedExitCodes ?? [0]).includes(code ?? -1)) {
        resolve(stdout);
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with ${signal ?? `exit code ${code ?? "unknown"}`}`));
    });
  });
}

export function runPnpm(args: readonly string[], options?: RunOptions): Promise<string> {
  return run("pnpm", args, options);
}

export function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
