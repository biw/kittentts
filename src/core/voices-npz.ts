import { unzipSync } from "fflate";

export interface NpyMatrix {
  shape: [number, number];
  data: Float32Array;
}

export interface VoicesNpz {
  [voiceName: string]: NpyMatrix;
}

function decodeHeader(bytes: Uint8Array): string {
  let header = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    header += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return header;
}

function parseShape(header: string): [number, number] {
  const match = header.match(/'shape':\s*\(([^)]*)\)/);
  if (!match) {
    throw new Error(`missing shape in npy header: ${header}`);
  }
  const dims = match[1]
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => Number.parseInt(value, 10));
  if (dims.length !== 2 || dims.some((value) => !Number.isFinite(value))) {
    throw new Error(`expected 2D shape in npy header: ${header}`);
  }
  return [dims[0], dims[1]];
}

function parseNpy(buffer: Uint8Array): NpyMatrix {
  const magic = String.fromCharCode(...buffer.slice(0, 6));
  if (magic !== "\u0093NUMPY") {
    throw new Error("invalid npy magic header");
  }

  const major = buffer[6];
  const headerLength =
    major === 1
      ? buffer[8] | (buffer[9] << 8)
      : buffer[8] | (buffer[9] << 8) | (buffer[10] << 16) | (buffer[11] << 24);
  const headerOffset = major === 1 ? 10 : 12;
  const header = decodeHeader(buffer.slice(headerOffset, headerOffset + headerLength));
  if (!header.includes("'descr': '<f4'")) {
    throw new Error(`unsupported npy dtype: ${header}`);
  }
  if (!header.includes("'fortran_order': False")) {
    throw new Error(`fortran-order arrays are not supported: ${header}`);
  }

  const shape = parseShape(header);
  const dataOffset = headerOffset + headerLength;
  const dataBytes = buffer.slice(dataOffset);
  const arrayBuffer = dataBytes.buffer.slice(
    dataBytes.byteOffset,
    dataBytes.byteOffset + dataBytes.byteLength,
  );
  const data = new Float32Array(arrayBuffer);
  if (data.length !== shape[0] * shape[1]) {
    throw new Error(`unexpected npy data length: got ${data.length}, expected ${shape[0] * shape[1]}`);
  }
  return { shape, data };
}

export function loadVoicesNpz(npzBytes: Uint8Array): VoicesNpz {
  const archive = unzipSync(npzBytes);
  const voices: VoicesNpz = {};
  for (const [filename, bytes] of Object.entries(archive)) {
    if (!filename.endsWith(".npy")) {
      continue;
    }
    voices[filename.slice(0, -4)] = parseNpy(bytes);
  }
  return voices;
}

export function selectStyleRow(voice: NpyMatrix, textLength: number) {
  const [rows, cols] = voice.shape;
  const refId = Math.min(textLength, rows - 1);
  const offset = refId * cols;
  return {
    refId,
    styleShape: [1, cols] as const,
    style: voice.data.slice(offset, offset + cols),
  };
}
