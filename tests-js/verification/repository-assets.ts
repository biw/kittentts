import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  type FixtureManifest,
} from "../../src/core/phoneme-feeds.js";
import { chunkMatchesFixture } from "../../src/core/pipeline.js";
import { resolveKittenTtsRepoAssets } from "../../src/core/repo-assets.js";
import { createNodeKittenTts } from "../../src/node/runtime.js";
import { downloadNodeKittenTtsRepoAssets } from "../../src/node/repo-assets.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function loadFixtureManifest(): Promise<FixtureManifest> {
  return JSON.parse(
    await fs.readFile(path.resolve(".context/reference-fixtures/manifest.json"), "utf8"),
  ) as FixtureManifest;
}

export async function verifyRepositoryAssets(): Promise<void> {
  const fixtureManifest = await loadFixtureManifest();
  const modelPath = path.resolve(".context/reference-fixtures", fixtureManifest.model_asset_path);
  const voicesPath = path.resolve(".context/reference-fixtures", fixtureManifest.voices_asset_path ?? "voices.npz");
  const repoId = "KittenML/mock-asset-loader";

  const repoConfig = {
    type: "ONNX2",
    model_file: "model.onnx",
    voices: "voices.npz",
    sample_rate: fixtureManifest.sample_rate,
    speed_priors: fixtureManifest.speed_priors,
    voice_aliases: fixtureManifest.voice_aliases,
  };

  let requestCount = 0;
  const requestsByPath = new Map<string, number>();
  const server = http.createServer(async (req, res) => {
    requestCount += 1;
    const requestPath = req.url?.split("?")[0] ?? "/";
    requestsByPath.set(requestPath, (requestsByPath.get(requestPath) ?? 0) + 1);
    const sendFile = async (filePath: string, contentType: string) => {
      const file = await fs.readFile(filePath);
      res.writeHead(200, { "Content-Type": contentType });
      res.end(file);
    };

    if (requestPath === `/${repoId}/resolve/main/config.json`) {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(repoConfig));
      return;
    }
    if (requestPath === `/${repoId}/resolve/main/model.onnx`) {
      await sendFile(modelPath, "application/octet-stream");
      return;
    }
    if (requestPath === `/${repoId}/resolve/main/voices.npz`) {
      await sendFile(voicesPath, "application/octet-stream");
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object", "failed to start mock repo server");
  const repoBaseUrl = `http://127.0.0.1:${address.port}/`;
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "kittentts-repo-assets-"));

  try {
    const resolved = await resolveKittenTtsRepoAssets({
      repoId,
      repoBaseUrl,
    });
    assert(resolved.modelUrl === `${repoBaseUrl}${repoId}/resolve/main/model.onnx`, "model URL mismatch");
    assert(resolved.voicesUrl === `${repoBaseUrl}${repoId}/resolve/main/voices.npz`, "voices URL mismatch");
    assert(resolved.config.sampleRate === fixtureManifest.sample_rate, "resolved sample rate mismatch");

    const [downloaded, concurrentDownload] = await Promise.all(
      [0, 1].map(() => downloadNodeKittenTtsRepoAssets({ repoId, repoBaseUrl, cacheDir })),
    );
    assert(downloaded.modelPath === concurrentDownload.modelPath, "concurrent model cache path mismatch");
    assert(downloaded.voicesPath === concurrentDownload.voicesPath, "concurrent voices cache path mismatch");
    assert(
      requestsByPath.get(`/${repoId}/resolve/main/model.onnx`) === 1,
      "concurrent initialization downloaded the model more than once",
    );
    assert(
      requestsByPath.get(`/${repoId}/resolve/main/voices.npz`) === 1,
      "concurrent initialization downloaded voices more than once",
    );
    assert(downloaded.modelPath.endsWith(path.join("KittenML", "mock-asset-loader", "main", "model.onnx")), "model cache path mismatch");
    assert(downloaded.voicesPath.endsWith(path.join("KittenML", "mock-asset-loader", "main", "voices.npz")), "voices cache path mismatch");

    const runtime = await createNodeKittenTts({
      repoId,
      repoBaseUrl,
      cacheDir,
    });
    try {
      const fixtureCase = fixtureManifest.cases[0];
      assert(fixtureCase, "missing first fixture case");
      const result = await runtime.synthesize({
        text: fixtureCase.text,
        voice: fixtureCase.voice,
        speed: fixtureCase.speed,
        cleanText: fixtureCase.clean_text,
      });
      assert(result.cleanedText === fixtureCase.cleaned_text, "repo-backed runtime cleaned text mismatch");
      assert(result.chunks.length === fixtureCase.chunks.length, "repo-backed runtime chunk count mismatch");
      for (let index = 0; index < result.chunks.length; index += 1) {
        const resultChunk = result.chunks[index];
        const fixtureChunk = fixtureCase.chunks[index];
        assert(fixtureChunk, `missing fixture chunk ${index}`);
        if (!chunkMatchesFixture(resultChunk, fixtureChunk)) {
          throw new Error(`repo-backed runtime chunk mismatch for ${fixtureCase.id} chunk ${index}`);
        }
      }
      console.log(
        JSON.stringify(
          {
            repoId,
            repoBaseUrl,
            requestCount,
            cacheDir: downloaded.cacheDir,
            sampleRate: result.sampleRate,
            cleanedText: result.cleanedText,
            chunks: result.chunks.length,
          },
          null,
          2,
        ),
      );
    } finally {
      await runtime.release();
    }
  } finally {
    server.close();
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
}
