const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const hasSecond = index + 1 < bytes.length;
    const hasThird = index + 2 < bytes.length;
    const second = hasSecond ? bytes[index + 1]! : 0;
    const third = hasThird ? bytes[index + 2]! : 0;
    output += BASE64_ALPHABET[first >>> 2];
    output += BASE64_ALPHABET[((first & 0x03) << 4) | (second >>> 4)];
    output += hasSecond ? BASE64_ALPHABET[((second & 0x0f) << 2) | (third >>> 6)] : "=";
    output += hasThird ? BASE64_ALPHABET[third & 0x3f] : "=";
  }
  return output;
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const normalized = base64.replace(/\s+/g, "");
  if (normalized.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(normalized)) {
    throw new Error("invalid base64 data");
  }
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  const output = new Uint8Array((normalized.length / 4) * 3 - padding);
  let offset = 0;
  for (let index = 0; index < normalized.length; index += 4) {
    const a = BASE64_ALPHABET.indexOf(normalized[index]!);
    const b = BASE64_ALPHABET.indexOf(normalized[index + 1]!);
    const c = normalized[index + 2] === "=" ? 0 : BASE64_ALPHABET.indexOf(normalized[index + 2]!);
    const d = normalized[index + 3] === "=" ? 0 : BASE64_ALPHABET.indexOf(normalized[index + 3]!);
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error("invalid base64 data");
    if (offset < output.length) output[offset++] = (a << 2) | (b >>> 4);
    if (offset < output.length) output[offset++] = ((b & 0x0f) << 4) | (c >>> 2);
    if (offset < output.length) output[offset++] = ((c & 0x03) << 6) | d;
  }
  return output;
}
