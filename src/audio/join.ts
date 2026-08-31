export function joinAudio(chunks: readonly Float32Array[], crossfadeSamples = 0): Float32Array {
  if (!Number.isInteger(crossfadeSamples) || crossfadeSamples < 0) {
    throw new Error("crossfadeSamples must be a non-negative integer");
  }
  if (chunks.length === 0) return new Float32Array();
  let output = chunks[0].slice();
  for (const chunk of chunks.slice(1)) {
    const overlap = Math.min(crossfadeSamples, output.length, chunk.length);
    const joined = new Float32Array(output.length + chunk.length - overlap);
    joined.set(output.subarray(0, output.length - overlap));
    for (let index = 0; index < overlap; index += 1) {
      const incoming = (index + 1) / (overlap + 1);
      joined[output.length - overlap + index] = output[output.length - overlap + index] * (1 - incoming) + chunk[index] * incoming;
    }
    joined.set(chunk.subarray(overlap), output.length);
    output = joined;
  }
  return output;
}
