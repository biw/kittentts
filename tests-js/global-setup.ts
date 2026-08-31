import { runPnpm } from "./helpers/process.js";

export default async function setup(): Promise<void> {
  await runPnpm(["exec", "tsc", "--noEmit"]);
  await runPnpm(["build"]);
  await runPnpm(["exec", "tsx", "scripts/bootstrap_reference_fixtures.ts"]);
}
