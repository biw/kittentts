#!/usr/bin/env python3
"""Generate lightweight text fixtures from the retained Python oracle."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
REFERENCE_ROOT = REPO_ROOT / "reference" / "python"
if str(REFERENCE_ROOT) not in sys.path:
    sys.path.insert(0, str(REFERENCE_ROOT))

from kittentts.preprocess import TextPreprocessor, chunk_text


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--corpus",
        type=Path,
        default=REPO_ROOT / "fixtures" / "text-parity-corpus.json",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=REPO_ROOT / "fixtures" / "text-parity.json",
    )
    args = parser.parse_args()

    corpus = json.loads(args.corpus.read_text())
    preprocessor = TextPreprocessor(remove_punctuation=False)
    cases = []
    for source in corpus["cases"]:
        cleaned = preprocessor(source["text"]) if source["clean_text"] else source["text"]
        cases.append(
            {
                **source,
                "cleaned_text": cleaned,
                "chunks": chunk_text(cleaned),
            }
        )

    fixture = {
        "schema_version": 1,
        "oracle": "reference/python/kittentts/preprocess.py",
        "corpus": str(args.corpus.relative_to(REPO_ROOT)),
        "cases": cases,
    }
    args.output.write_text(json.dumps(fixture, indent=2, ensure_ascii=True) + "\n")
    print(f"Wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
