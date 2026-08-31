export interface ReactNativeDownloadBeginResult {
  jobId: number;
  statusCode: number;
  contentLength: number;
}

export interface ReactNativeDownloadProgressResult {
  jobId: number;
  contentLength: number;
  bytesWritten: number;
}

export interface ReactNativeDownloadResult {
  jobId: number;
  statusCode: number;
  bytesWritten: number;
}

export interface ReactNativeDownloadJob {
  jobId: number;
  promise: Promise<ReactNativeDownloadResult>;
}

export interface ReactNativeFileStat {
  size: number | string;
  path?: string;
  name?: string;
  isFile?(): boolean;
  isDirectory?(): boolean;
}

/** The narrow native filesystem surface required by the SDK. */
export interface ReactNativeFileSystem {
  CachesDirectoryPath: string;
  DocumentDirectoryPath: string;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  readFile(path: string, encoding?: "utf8" | "base64"): Promise<string>;
  writeFile(path: string, contents: string, encoding?: "utf8" | "base64"): Promise<void>;
  unlink(path: string): Promise<void>;
  moveFile(sourcePath: string, destinationPath: string): Promise<void>;
  hash(path: string, algorithm: "sha256"): Promise<string>;
  stat(path: string): Promise<ReactNativeFileStat>;
  readDir(path: string): Promise<ReactNativeFileStat[]>;
  downloadFile(options: {
    fromUrl: string;
    toFile: string;
    background?: boolean;
    discretionary?: boolean;
    cacheable?: boolean;
    progressInterval?: number;
    connectionTimeout?: number;
    readTimeout?: number;
    backgroundTimeout?: number;
    begin?: (result: ReactNativeDownloadBeginResult) => void;
    progress?: (result: ReactNativeDownloadProgressResult) => void;
  }): ReactNativeDownloadJob;
  stopDownload(jobId: number): void;
}

export type ReactNativeOrtTensorData =
  | Float32Array
  | BigInt64Array
  | BigUint64Array
  | Int32Array
  | Uint32Array;

export interface ReactNativeOrtTensor {
  readonly data: ReactNativeOrtTensorData;
}

export interface ReactNativeOrtSession {
  readonly outputNames: readonly string[];
  run(feeds: Record<string, ReactNativeOrtTensor>): Promise<Record<string, ReactNativeOrtTensor>>;
  release(): void | Promise<void>;
}

export interface ReactNativeOrtModule {
  InferenceSession: {
    create(model: string | Uint8Array, options?: Record<string, unknown>): Promise<ReactNativeOrtSession>;
  };
  Tensor: new(
    type: "int64" | "float32",
    data: BigInt64Array | Float32Array,
    dimensions: readonly number[],
  ) => ReactNativeOrtTensor;
}

export async function loadReactNativeFileSystem(): Promise<ReactNativeFileSystem> {
  const loaded = await import("@dr.pogodin/react-native-fs");
  return ((loaded as { default?: unknown }).default ?? loaded) as ReactNativeFileSystem;
}

export async function loadReactNativeOrt(): Promise<ReactNativeOrtModule> {
  return await import("onnxruntime-react-native") as unknown as ReactNativeOrtModule;
}
