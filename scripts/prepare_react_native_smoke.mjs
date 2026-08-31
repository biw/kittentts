import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = path.join(repoRoot, "tests-native", "react-native-smoke");
const packRoot = path.join(repoRoot, ".context", "native-smoke-package");
const installedPackage = path.join(appRoot, "node_modules", "@biwills", "kittentts");

function run(command, args, cwd = repoRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? "a signal"}`));
    });
  });
}

async function main() {
  await fs.rm(packRoot, { recursive: true, force: true });
  await fs.mkdir(packRoot, { recursive: true });
  await run("pnpm", ["pack", "--pack-destination", packRoot]);
  const tarballs = (await fs.readdir(packRoot)).filter(filename => filename.endsWith(".tgz"));
  if (tarballs.length !== 1) throw new Error(`expected one package tarball, found ${tarballs.length}`);
  const tarball = path.join(packRoot, tarballs[0]);

  await run(
    "pnpm",
    ["--ignore-workspace", "--config.auto-install-peers=false", "install", "--frozen-lockfile"],
    appRoot,
  );
  await fs.rm(installedPackage, { recursive: true, force: true });
  await fs.mkdir(installedPackage, { recursive: true });
  await run("tar", ["-xzf", tarball, "--strip-components=1", "-C", installedPackage]);

  const installedManifest = JSON.parse(await fs.readFile(path.join(installedPackage, "package.json"), "utf8"));
  console.log(JSON.stringify({ status: "pass", tarball, installedPackage, version: installedManifest.version }, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
