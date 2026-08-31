export async function readResponseBytes(
  response: Response,
  options: { signal?: AbortSignal; onProgress?: (loadedBytes: number, totalBytes?: number) => void } = {},
): Promise<Uint8Array> {
  const totalBytes = Number(response.headers.get("content-length")) || undefined;
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    options.signal?.throwIfAborted();
    options.onProgress?.(bytes.byteLength, totalBytes);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loadedBytes = 0;
  try {
    while (true) {
      options.signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loadedBytes += value.byteLength;
      options.onProgress?.(loadedBytes, totalBytes);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(loadedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
