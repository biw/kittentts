# Python Reference Oracle

This directory retains the upstream Python implementation solely as an
independent oracle for generating and reviewing JavaScript parity fixtures.
It is not part of the npm package, JavaScript build, installation, or runtime.

The JavaScript release gate consumes committed fixtures and does not invoke
Python. Lightweight normalization tests protect the oracle itself:

```bash
PYTHONPATH=reference/python python -m unittest discover reference/python/tests
```

To regenerate full audio fixtures, use an isolated environment with the
dependencies declared by this project:

```bash
uv run --project reference/python \
  python reference/python/tools/generate_audio_fixtures.py \
  --portable-manifest fixtures/reference-manifest.json
```

Regeneration is an explicit maintenance operation because it downloads pinned
model assets and runs the Python ONNX pipeline. Review fixture diffs and
listening samples before accepting an oracle update.
