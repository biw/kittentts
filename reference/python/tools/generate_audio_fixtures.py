#!/usr/bin/env python3
"""Generate golden fixtures from the current Python KittenTTS pipeline."""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import hashlib
import json
import shutil
import sys
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[3]
REFERENCE_ROOT = ROOT / "reference" / "python"
if str(REFERENCE_ROOT) not in sys.path:
    sys.path.insert(0, str(REFERENCE_ROOT))

from kittentts.get_model import download_from_huggingface
from kittentts.onnx_model import basic_english_tokenize, chunk_text


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def audio_stats(audio: np.ndarray) -> dict[str, Any]:
    flat = np.asarray(audio, dtype=np.float32).reshape(-1)
    return {
        "num_samples": int(flat.shape[0]),
        "min": float(np.min(flat)),
        "max": float(np.max(flat)),
        "mean": float(np.mean(flat)),
        "std": float(np.std(flat)),
        "rms": float(np.sqrt(np.mean(np.square(flat)))),
        "float32_sha256": sha256_bytes(flat.astype("<f4", copy=False).tobytes()),
        "signature": audio_signature(flat),
    }


def audio_signature(audio: np.ndarray, bins: int = 32) -> dict[str, Any]:
    flat = np.asarray(audio, dtype=np.float32).reshape(-1)
    rms: list[float] = []
    delta_rms: list[float] = []
    zero_crossing_rate: list[float] = []
    for index in range(bins):
        start = (index * flat.shape[0]) // bins
        end = ((index + 1) * flat.shape[0]) // bins
        segment = flat[start:end]
        rms.append(float(np.sqrt(np.mean(np.square(segment)))))
        differences = np.diff(segment)
        delta_rms.append(
            float(np.sqrt(np.mean(np.square(differences)))) if differences.size else 0.0
        )
        crossings = np.count_nonzero((segment[:-1] < 0) != (segment[1:] < 0))
        zero_crossing_rate.append(float(crossings / max(1, segment.size - 1)))
    return {
        "bins": bins,
        "rms": rms,
        "delta_rms": delta_rms,
        "zero_crossing_rate": zero_crossing_rate,
    }


def portable_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    portable = copy.deepcopy(manifest)
    portable["model_path"] = portable["model_asset_path"]
    for case in portable["cases"]:
        case["wav_path"] = ""
        case["raw_audio_path"] = ""
        for chunk in case["chunks"]:
            chunk["audio_path"] = ""
    return portable


def resolve_voice(model, voice: str) -> str:
    return model.voice_aliases.get(voice, voice)


def effective_speed(model, voice: str, speed: float) -> float:
    return speed * model.speed_priors.get(voice, 1.0)


def generate_case(model, case: dict[str, Any], sample_rate: int, output_dir: Path) -> dict[str, Any]:
    voice = case["voice"]
    speed = float(case.get("speed", 1.0))
    clean_text = bool(case.get("clean_text", True))
    source_text = case["text"]
    cleaned_text = model.preprocessor(source_text) if clean_text else source_text
    chunks = chunk_text(cleaned_text)

    case_audio = model.generate(source_text, voice=voice, speed=speed, clean_text=clean_text)
    audio_dir = output_dir / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    wav_path = audio_dir / f"{case['id']}.wav"
    sf.write(wav_path, case_audio, sample_rate)
    raw_audio_path = audio_dir / f"{case['id']}.f32"
    raw_audio_path.write_bytes(np.asarray(case_audio, dtype="<f4").reshape(-1).tobytes())

    chunk_records = []
    for index, text_chunk in enumerate(chunks):
        resolved_voice = resolve_voice(model, voice)
        if resolved_voice not in model.available_voices:
            raise ValueError(
                f"Case {case['id']} resolved voice '{resolved_voice}' is not in {model.available_voices}"
            )

        phonemes_raw = model.phonemizer.phonemize([text_chunk])[0]
        phonemes_tokenized = " ".join(basic_english_tokenize(phonemes_raw))
        token_ids = model.text_cleaner(phonemes_tokenized)
        token_ids = [0, *token_ids, 10, 0]

        ref_id = min(len(text_chunk), model.voices[resolved_voice].shape[0] - 1)
        style = np.asarray(model.voices[resolved_voice][ref_id : ref_id + 1], dtype=np.float32)
        speed_value = np.asarray(
            [effective_speed(model, resolved_voice, speed)],
            dtype=np.float32,
        )

        chunk_audio = model.generate_single_chunk(text_chunk, voice=voice, speed=speed)
        chunk_audio_path = audio_dir / f"{case['id']}__chunk_{index}.f32"
        chunk_audio_path.write_bytes(np.asarray(chunk_audio, dtype="<f4").reshape(-1).tobytes())
        chunk_records.append(
            {
                "index": index,
                "text": text_chunk,
                "resolved_voice": resolved_voice,
                "effective_speed": float(speed_value[0]),
                "phonemes_raw": phonemes_raw,
                "phonemes_tokenized": phonemes_tokenized,
                "input_ids": token_ids,
                "input_ids_sha256": sha256_bytes(np.asarray(token_ids, dtype="<i8").tobytes()),
                "ref_id": int(ref_id),
                "style_shape": list(style.shape),
                "style": style.tolist(),
                "style_sha256": sha256_bytes(style.astype("<f4", copy=False).tobytes()),
                "speed": speed_value.tolist(),
                "audio": audio_stats(chunk_audio),
                "audio_path": str(chunk_audio_path.relative_to(output_dir)),
            }
        )

    wav_bytes = wav_path.read_bytes()
    return {
        "id": case["id"],
        "text": source_text,
        "voice": voice,
        "speed": speed,
        "clean_text": clean_text,
        "cleaned_text": cleaned_text,
        "chunk_count": len(chunk_records),
        "wav_path": str(wav_path.relative_to(output_dir)),
        "wav_sha256": sha256_bytes(wav_bytes),
        "raw_audio_path": str(raw_audio_path.relative_to(output_dir)),
        "audio": audio_stats(case_audio),
        "chunks": chunk_records,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--corpus",
        type=Path,
        default=ROOT / "fixtures" / "reference-corpus.json",
        help="Path to the reference corpus JSON file.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=ROOT / ".context" / "reference-fixtures",
        help="Directory where manifest JSON and WAV files should be written.",
    )
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=None,
        help="Optional Hugging Face cache directory.",
    )
    parser.add_argument(
        "--model",
        type=str,
        default=None,
        help="Override the model name declared in the corpus.",
    )
    parser.add_argument(
        "--revision",
        type=str,
        default=None,
        help="Override the pinned Hugging Face revision declared in the corpus.",
    )
    parser.add_argument(
        "--portable-manifest",
        type=Path,
        default=None,
        help="Also write a path-sanitized manifest suitable for committing.",
    )
    args = parser.parse_args()

    corpus = json.loads(args.corpus.read_text())
    model_name = args.model or corpus["model"]
    revision = args.revision or corpus.get("revision")
    sample_rate = int(corpus.get("sample_rate", 24000))
    output_dir = args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Loading model {model_name} ...", file=sys.stderr)
    model = download_from_huggingface(
        repo_id=model_name,
        cache_dir=str(args.cache_dir) if args.cache_dir else None,
        revision=revision,
    )

    cases = [
        generate_case(model, case, sample_rate=sample_rate, output_dir=output_dir)
        for case in corpus["cases"]
    ]
    model_asset_path = output_dir / "model.onnx"
    shutil.copyfile(model.model_path, model_asset_path)
    voices_asset_path = output_dir / "voices.npz"
    shutil.copyfile(model.voices_path, voices_asset_path)

    manifest = {
        "schema_version": 1,
        "generated_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "model": model_name,
        "revision": revision,
        "model_path": str(Path(model.model_path).resolve()),
        "model_asset_path": str(model_asset_path.relative_to(output_dir)),
        "voices_asset_path": str(voices_asset_path.relative_to(output_dir)),
        "speed_priors": model.speed_priors,
        "voice_aliases": model.voice_aliases,
        "sample_rate": sample_rate,
        "corpus_path": str(args.corpus.relative_to(ROOT)),
        "cases": cases,
    }
    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2))
    print(f"Wrote {manifest_path}", file=sys.stderr)
    if args.portable_manifest:
        args.portable_manifest.parent.mkdir(parents=True, exist_ok=True)
        args.portable_manifest.write_text(json.dumps(portable_manifest(manifest), indent=2))
        print(f"Wrote {args.portable_manifest}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
