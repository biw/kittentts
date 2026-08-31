import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".context", "native-smoke-assets");
const port = Number(process.env.KITTENTTS_NATIVE_ASSET_PORT ?? 9123);
const knownFiles = new Set([
  "config.json",
  "kitten_tts_nano_v0_8.onnx",
  "voices.npz",
  "en_rules",
  "en_list",
  "manifest.json",
]);
const contentTypes = {
  ".json": "application/json",
  ".onnx": "application/octet-stream",
  ".npz": "application/octet-stream",
};

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`).pathname;
  const filename = path.basename(decodeURIComponent(pathname));
  if (!knownFiles.has(filename)) {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found\n");
    return;
  }
  const filePath = path.join(root, filename);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    response.writeHead(503, { "content-type": "text/plain" });
    response.end(`missing fixture: ${filename}\n`);
    return;
  }
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": stat.size,
    "content-type": contentTypes[path.extname(filename)] ?? "text/plain; charset=utf-8",
  });
  if (request.method === "HEAD") response.end();
  else fs.createReadStream(filePath).pipe(response);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`KITTENTTS_NATIVE_ASSET_SERVER_READY http://0.0.0.0:${port}/`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
