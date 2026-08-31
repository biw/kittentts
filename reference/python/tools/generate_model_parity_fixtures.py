#!/usr/bin/env python3
"""Generate multi-model parity fixtures from locally cached pinned assets."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[3]
REFERENCE_ROOT = REPO_ROOT / "reference" / "python"
if str(REFERENCE_ROOT) not in sys.path:
    sys.path.insert(0, str(REFERENCE_ROOT))

from kittentts.onnx_model import KittenTTS_1_Onnx, chunk_text

MODELS = [
    {
        "id": "nano",
        "repoId": "KittenML/kitten-tts-nano-0.8-fp32",
        "revision": "7a1db645b1f3ab9420761d87428e042b9cec3f26",
        "nodeSampleTolerance": 0,
        "browserSampleTolerance": 0,
    },
    {
        "id": "nano-int8",
        "repoId": "KittenML/kitten-tts-nano-0.8-int8",
        "revision": "84781d74e29ee25217551556398b42f80593a813",
        "nodeSampleTolerance": 600,
        "browserSampleTolerance": 600,
    },
    {
        "id": "micro",
        "repoId": "KittenML/kitten-tts-micro-0.8",
        "revision": "1ccf72b2c2048fd17efac7de2fab32d10e225084",
        "nodeSampleTolerance": 3000,
        "browserSampleTolerance": 3000,
    },
    {
        "id": "mini",
        "repoId": "KittenML/kitten-tts-mini-0.8",
        "revision": "c02725660cea441db4c383af69f1f26f5cd00947",
        "nodeSampleTolerance": 18000,
        "browserSampleTolerance": 18000,
    },
]


def sha256(array: np.ndarray, dtype: str) -> str:
    return hashlib.sha256(np.asarray(array, dtype=dtype).tobytes()).hexdigest()


def audio_stats(audio: np.ndarray) -> dict[str, Any]:
    flat = np.asarray(audio, dtype=np.float32).reshape(-1)
    return {
        "numSamples": int(flat.size),
        "min": float(np.min(flat)),
        "max": float(np.max(flat)),
        "mean": float(np.mean(flat)),
        "std": float(np.std(flat)),
        "rms": float(np.sqrt(np.mean(np.square(flat)))),
    }


def main() -> int:
    corpus_path = REPO_ROOT / "fixtures" / "model-parity-corpus.json"
    output_path = REPO_ROOT / "fixtures" / "model-parity.json"
    cache_root = REPO_ROOT / ".context" / "model-matrix-cache"
    corpus = json.loads(corpus_path.read_text())
    output_models = []

    for definition in MODELS:
        asset_dir = (
            cache_root
            / definition["repoId"]
            / definition["revision"]
        )
        config = json.loads((asset_dir / "config.json").read_text())
        model = KittenTTS_1_Onnx(
            model_path=str(asset_dir / config["model_file"]),
            voices_path=str(asset_dir / config["voices"]),
            speed_priors=config.get("speed_priors", {}),
            voice_aliases=config.get("voice_aliases", {}),
            backend="cpu",
        )
        expected_cases = []
        for source in corpus["cases"]:
            cleaned = model.preprocessor(source["text"]) if source["clean_text"] else source["text"]
            chunks = chunk_text(cleaned)
            if len(chunks) != 1:
                raise ValueError(f"{definition['id']}:{source['id']} must contain exactly one chunk")
            feeds = model._prepare_inputs(
                chunks[0],
                voice=source["voice"],
                speed=float(source["speed"]),
            )
            audio = model.generate(
                source["text"],
                voice=source["voice"],
                speed=float(source["speed"]),
                clean_text=bool(source["clean_text"]),
            )
            expected_cases.append(
                {
                    "id": source["id"],
                    "inputIdsSha256": sha256(feeds["input_ids"], "<i8"),
                    "styleSha256": sha256(feeds["style"], "<f4"),
                    "audio": {
                        **audio_stats(audio),
                        "nodeSampleTolerance": definition["nodeSampleTolerance"],
                        "browserSampleTolerance": definition["browserSampleTolerance"],
                    },
                }
            )
        output_models.append(
            {
                "id": definition["id"],
                "repoId": definition["repoId"],
                "revision": definition["revision"],
                "cases": expected_cases,
            }
        )

    output = {
        "schemaVersion": 2,
        "source": "reference/python with onnxruntime",
        "corpus": str(corpus_path.relative_to(REPO_ROOT)),
        "models": output_models,
    }
    output_path.write_text(json.dumps(output, indent=2) + "\n")
    print(f"Wrote {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
