import type { Phonemizer } from "../core/phonemizer.js";
import { phonemizeWithPreservedPunctuation } from "../core/phonemizer.js";
import { defaultReactNativeKittenTtsCacheDir } from "./repo-assets.js";
import {
  loadReactNativeFileSystem,
  type ReactNativeDownloadResult,
  type ReactNativeFileSystem,
} from "./types.js";
import createCEPhonemizerModule from "./vendor/cephonemizer-runtime.cjs";

const ESPEAK_REVISION = "59eb19938f12e30881c81d86ce4a7de25414c9f4";
const DEFAULT_RULES_URL = `https://raw.githubusercontent.com/espeak-ng/espeak-ng/${ESPEAK_REVISION}/dictsource/en_rules`;
const DEFAULT_LIST_URL = `https://raw.githubusercontent.com/espeak-ng/espeak-ng/${ESPEAK_REVISION}/dictsource/en_list`;
const DEFAULT_RULES_SHA256 = "8e75e9341ea735cc514b29a7d3a95c6c241c1cc176ad43e5699b8f7f66ab3194";
const DEFAULT_LIST_SHA256 = "24eb79018ed6253c10682096de672ce9265c1fe15c3e19e7f754d57a0fcd9790";
const VIRTUAL_DIRECTORY = "/cephonemizer";
const VIRTUAL_RULES_PATH = `${VIRTUAL_DIRECTORY}/en_rules`;
const VIRTUAL_LIST_PATH = `${VIRTUAL_DIRECTORY}/en_list`;
const downloadsInFlight = new Map<string, Promise<string>>();

interface CEPhonemizerModule {
  FS: {
    mkdir(path: string): void;
    writeFile(path: string, contents: string): void;
  };
  UTF8ToString(pointer: number): string;
  cwrap(
    identifier: string,
    returnType: "number" | null,
    argumentTypes: Array<"number" | "string">,
  ): unknown;
}

type CEPhonemizerModuleFactory = () => Promise<CEPhonemizerModule>;
type CreateHandle = (rulesPath: string, listPath: string, dialect: string) => number;
type DestroyHandle = (handle: number) => void;
type PhonemizeHandle = (handle: number, text: string) => number;
type FreeString = (pointer: number) => void;

export interface ReactNativeCePhonemizerOptions {
  cacheDir?: string;
  rulesUrl?: string;
  listUrl?: string;
  rulesPath?: string;
  listPath?: string;
  rulesText?: string;
  listText?: string;
  rulesSha256?: string | false;
  listSha256?: string | false;
  dialect?: string;
  retries?: number;
  signal?: AbortSignal;
  fileSystem?: ReactNativeFileSystem;
  onDownloadProgress?: (asset: "phonemizer-rules" | "phonemizer-list", loadedBytes: number, totalBytes?: number) => void;
  /** Replaces the bundled asm.js module. Intended for deterministic tests. */
  moduleFactory?: CEPhonemizerModuleFactory;
}

interface PreparedPhonemizerData {
  rules: string;
  list: string;
}

function joinPath(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((part, index) => index === 0 ? part.replace(/\/+$/g, "") : part.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}

async function deleteIfExists(fileSystem: ReactNativeFileSystem, targetPath: string): Promise<void> {
  if (await fileSystem.exists(targetPath)) await fileSystem.unlink(targetPath);
}

async function assertIntegrity(
  fileSystem: ReactNativeFileSystem,
  filePath: string,
  expectedSha256?: string,
): Promise<void> {
  if (!expectedSha256) return;
  const actual = (await fileSystem.hash(filePath, "sha256")).toLowerCase();
  if (actual !== expectedSha256.toLowerCase()) {
    throw new Error(`phonemizer asset integrity check failed: expected ${expectedSha256}, got ${actual}`);
  }
}

async function waitForDownload(
  fileSystem: ReactNativeFileSystem,
  jobId: number,
  promise: Promise<ReactNativeDownloadResult>,
  signal?: AbortSignal,
): Promise<ReactNativeDownloadResult> {
  signal?.throwIfAborted();
  if (!signal) return promise;
  return await new Promise<ReactNativeDownloadResult>((resolve, reject) => {
    const onAbort = () => {
      try { fileSystem.stopDownload(jobId); } catch { /* best-effort native cancellation */ }
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (result) => { signal.removeEventListener("abort", onAbort); resolve(result); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function downloadTextAssetUncoordinated(
  fileSystem: ReactNativeFileSystem,
  asset: "phonemizer-rules" | "phonemizer-list",
  url: string,
  destinationPath: string,
  expectedSha256: string | undefined,
  options: ReactNativeCePhonemizerOptions,
): Promise<string> {
  if (await fileSystem.exists(destinationPath)) {
    try {
      await assertIntegrity(fileSystem, destinationPath, expectedSha256);
      return await fileSystem.readFile(destinationPath, "utf8");
    } catch {
      await deleteIfExists(fileSystem, destinationPath);
    }
  }

  await fileSystem.mkdir(destinationPath.slice(0, destinationPath.lastIndexOf("/")));
  const temporaryPath = `${destinationPath}.${Date.now()}.download`;
  let lastError: unknown;
  try {
    for (let attempt = 0; attempt <= (options.retries ?? 2); attempt += 1) {
      options.signal?.throwIfAborted();
      await deleteIfExists(fileSystem, temporaryPath);
      let totalBytes: number | undefined;
      try {
        const job = fileSystem.downloadFile({
          fromUrl: url,
          toFile: temporaryPath,
          cacheable: false,
          progressInterval: 100,
          connectionTimeout: 30_000,
          readTimeout: 30_000,
          backgroundTimeout: 10 * 60_000,
          begin: (result) => { totalBytes = result.contentLength > 0 ? result.contentLength : undefined; },
          progress: (result) => {
            const total = result.contentLength > 0 ? result.contentLength : totalBytes;
            options.onDownloadProgress?.(asset, result.bytesWritten, total);
          },
        });
        const result = await waitForDownload(fileSystem, job.jobId, job.promise, options.signal);
        if (result.statusCode < 200 || result.statusCode >= 300) {
          throw new Error(`failed to download ${asset}: HTTP ${result.statusCode}`);
        }
        await assertIntegrity(fileSystem, temporaryPath, expectedSha256);
        await fileSystem.moveFile(temporaryPath, destinationPath);
        options.onDownloadProgress?.(asset, result.bytesWritten, totalBytes);
        return await fileSystem.readFile(destinationPath, "utf8");
      } catch (error) {
        lastError = error;
        await deleteIfExists(fileSystem, temporaryPath);
        if (options.signal?.aborted) throw options.signal.reason ?? error;
        if (attempt < (options.retries ?? 2)) await delay(250 * 2 ** attempt, options.signal);
      }
    }
  } finally {
    await deleteIfExists(fileSystem, temporaryPath);
  }
  throw lastError ?? new Error(`failed to download ${asset}`);
}

async function downloadTextAsset(
  fileSystem: ReactNativeFileSystem,
  asset: "phonemizer-rules" | "phonemizer-list",
  url: string,
  destinationPath: string,
  expectedSha256: string | undefined,
  options: ReactNativeCePhonemizerOptions,
): Promise<string> {
  const existing = downloadsInFlight.get(destinationPath);
  if (existing) return await existing;
  const download = downloadTextAssetUncoordinated(
    fileSystem,
    asset,
    url,
    destinationPath,
    expectedSha256,
    options,
  );
  downloadsInFlight.set(destinationPath, download);
  try {
    return await download;
  } finally {
    if (downloadsInFlight.get(destinationPath) === download) downloadsInFlight.delete(destinationPath);
  }
}

function validatePairedOptions(options: ReactNativeCePhonemizerOptions): void {
  if ((options.rulesText === undefined) !== (options.listText === undefined)) {
    throw new Error("rulesText and listText must be provided together");
  }
  if ((options.rulesPath === undefined) !== (options.listPath === undefined)) {
    throw new Error("rulesPath and listPath must be provided together");
  }
}

async function prepareData(
  fileSystem: ReactNativeFileSystem,
  options: ReactNativeCePhonemizerOptions,
): Promise<PreparedPhonemizerData> {
  validatePairedOptions(options);
  if (options.rulesText !== undefined && options.listText !== undefined) {
    return { rules: options.rulesText, list: options.listText };
  }
  if (options.rulesPath && options.listPath) {
    const rulesPath = options.rulesPath.replace(/^file:\/\//, "");
    const listPath = options.listPath.replace(/^file:\/\//, "");
    if (typeof options.rulesSha256 === "string") await assertIntegrity(fileSystem, rulesPath, options.rulesSha256);
    if (typeof options.listSha256 === "string") await assertIntegrity(fileSystem, listPath, options.listSha256);
    return {
      rules: await fileSystem.readFile(rulesPath, "utf8"),
      list: await fileSystem.readFile(listPath, "utf8"),
    };
  }

  const rulesUrl = options.rulesUrl ?? DEFAULT_RULES_URL;
  const listUrl = options.listUrl ?? DEFAULT_LIST_URL;
  const directory = options.cacheDir ?? joinPath(
    defaultReactNativeKittenTtsCacheDir(fileSystem),
    "phonemizer",
    ESPEAK_REVISION,
  );
  const rulesSha256 = options.rulesSha256 === false
    ? undefined
    : options.rulesSha256 ?? (rulesUrl === DEFAULT_RULES_URL ? DEFAULT_RULES_SHA256 : undefined);
  const listSha256 = options.listSha256 === false
    ? undefined
    : options.listSha256 ?? (listUrl === DEFAULT_LIST_URL ? DEFAULT_LIST_SHA256 : undefined);
  const [rules, list] = await Promise.all([
    downloadTextAsset(fileSystem, "phonemizer-rules", rulesUrl, joinPath(directory, "en_rules"), rulesSha256, options),
    downloadTextAsset(fileSystem, "phonemizer-list", listUrl, joinPath(directory, "en_list"), listSha256, options),
  ]);
  return { rules, list };
}

export class ReactNativeCePhonemizer implements Phonemizer {
  readonly #module: CEPhonemizerModule;
  readonly #handle: number;
  readonly #phonemizeHandle: PhonemizeHandle;
  readonly #freeString: FreeString;
  readonly #destroyHandle: DestroyHandle;
  #disposed = false;

  static async create(options: ReactNativeCePhonemizerOptions = {}): Promise<ReactNativeCePhonemizer> {
    const fileSystem = options.fileSystem ?? await loadReactNativeFileSystem();
    const { rules, list } = await prepareData(fileSystem, options);
    options.signal?.throwIfAborted();
    const module = await (options.moduleFactory ?? createCEPhonemizerModule)();
    try { module.FS.mkdir(VIRTUAL_DIRECTORY); } catch { /* directory already exists */ }
    module.FS.writeFile(VIRTUAL_RULES_PATH, rules);
    module.FS.writeFile(VIRTUAL_LIST_PATH, list);
    const createHandle = module.cwrap(
      "phonemizer_create",
      "number",
      ["string", "string", "string"],
    ) as CreateHandle;
    const destroyHandle = module.cwrap("phonemizer_destroy", null, ["number"]) as DestroyHandle;
    const phonemizeHandle = module.cwrap(
      "phonemizer_phonemize",
      "number",
      ["number", "string"],
    ) as PhonemizeHandle;
    const freeString = module.cwrap("phonemizer_free_string", null, ["number"]) as FreeString;
    const handle = createHandle(VIRTUAL_RULES_PATH, VIRTUAL_LIST_PATH, options.dialect ?? "en-us");
    if (!handle) throw new Error("CEPhonemizer failed to load its English rules and dictionary");
    return new ReactNativeCePhonemizer(module, handle, phonemizeHandle, freeString, destroyHandle);
  }

  private constructor(
    module: CEPhonemizerModule,
    handle: number,
    phonemizeHandle: PhonemizeHandle,
    freeString: FreeString,
    destroyHandle: DestroyHandle,
  ) {
    this.#module = module;
    this.#handle = handle;
    this.#phonemizeHandle = phonemizeHandle;
    this.#freeString = freeString;
    this.#destroyHandle = destroyHandle;
  }

  async phonemize(text: string): Promise<string> {
    if (this.#disposed) throw new Error("CEPhonemizer has been disposed");
    return phonemizeWithPreservedPunctuation(text, "en-us", async (phrase) => {
      const resultPointer = this.#phonemizeHandle(this.#handle, phrase);
      if (!resultPointer) throw new Error("CEPhonemizer failed to phonemize text");
      try {
        return [this.#module.UTF8ToString(resultPointer)];
      } finally {
        this.#freeString(resultPointer);
      }
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#destroyHandle(this.#handle);
  }
}

export async function createReactNativeCePhonemizer(
  options: ReactNativeCePhonemizerOptions = {},
): Promise<ReactNativeCePhonemizer> {
  return ReactNativeCePhonemizer.create(options);
}
