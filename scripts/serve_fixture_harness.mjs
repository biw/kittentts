import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const staticRoot = path.resolve(process.env.STATIC_ROOT ?? repoRoot);
const modelCacheRoot = path.resolve(process.env.KITTENTTS_MATRIX_CACHE ?? path.join(repoRoot, ".context", "model-matrix-cache"));
const host = "127.0.0.1";
const port = Number(process.env.PORT || 4173);

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".onnx", "application/octet-stream"],
  [".wasm", "application/wasm"],
  [".wav", "audio/wav"],
  [".f32", "application/octet-stream"],
  [".css", "text/css; charset=utf-8"],
]);

function send(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: data:; worker-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'",
    ...headers,
  });
  res.end(body);
}

function resolvePath(urlPath) {
  const normalized = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.(\/|\\|$))+/, "");
  const pathname = normalized === "/" ? "/web/fixture-check.html" : normalized;
  return path.join(staticRoot, pathname);
}

function resolveModelAssetPath(urlPath) {
  const match = urlPath.match(/^\/([^/]+)\/([^/]+)\/resolve\/([^/]+)\/(.+)$/);
  if (!match) return undefined;
  const segments = match.slice(1).flatMap((segment) => decodeURIComponent(segment).split("/"));
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return undefined;
  return path.join(modelCacheRoot, ...segments);
}

function isWithinRoot(filePath, root) {
  const relativePath = path.relative(root, filePath);
  return relativePath && !relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath);
}

const server = http.createServer((req, res) => {
  if (!req.url) {
    send(res, 400, "Bad Request");
    return;
  }

  const [pathname] = req.url.split("?");
  if (pathname === "/favicon.ico") {
    send(res, 204, "");
    return;
  }
  const modelAssetPath = resolveModelAssetPath(pathname);
  const filePath = modelAssetPath ?? resolvePath(pathname);
  const fileRoot = modelAssetPath ? modelCacheRoot : staticRoot;
  if (!isWithinRoot(filePath, fileRoot)) {
    send(res, 403, "Forbidden");
    return;
  }

  fs.stat(filePath, (statError, stats) => {
    if (statError) {
      send(res, 404, "Not Found");
      return;
    }

    const target = stats.isDirectory() ? path.join(filePath, "index.html") : filePath;
    fs.readFile(target, (readError, file) => {
      if (readError) {
        send(res, 404, "Not Found");
        return;
      }
      send(res, 200, file, {
        "Content-Type": contentTypes.get(path.extname(target)) || "application/octet-stream",
      });
    });
  });
});

server.listen(port, host, () => {
  console.log(`Static root: ${staticRoot}`);
  console.log(`Fixture harness: http://${host}:${port}/web/fixture-check.html`);
  console.log(`Browser example: http://${host}:${port}/examples/browser-basic.html`);
});
