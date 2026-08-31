# Phonemizer Decision

## Decision

The production SDK retains the `phonemizer` npm package behind the internal `Phonemizer` interface. Its adapted output is exact for all 20 chunks in the committed 13-case Python/eSpeak corpus, plus three independent phrases across each of the four registered models. The adapter preserves punctuation and applies one documented eSpeak compatibility correction.

## CEPhonemizer Evaluation

KittenTTS-web's CEPhonemizer has a useful architecture: an Apache-2.0 C++ implementation reads pinned eSpeak English rule/list data and exposes a disposable async interface. It was not adopted for this release for three testable reasons:

- The referenced repository does not contain its generated `cephonemizer.js`, so a clean npm checkout cannot execute or benchmark it.
- Rebuilding requires Emscripten, and the build script discovers Python. That would reintroduce a release-tool dependency this project intentionally avoids.
- Its rule/list files are fetched separately at runtime, while the selected npm phonemizer is self-contained and already proven against the Python fixture corpus.

The CE source itself is Apache-2.0 and labels the downloaded eSpeak rules as GPL-licensed data. The current npm dependency declares Apache-2.0. Downstream distributors should run their own license review.

## Measured Gate

`pnpm test` runs the phonemizer parity test for every golden chunk byte-for-byte and reports elapsed time. Correctness is a hard gate; raw package output and compatibility-adapted output are reported separately. The abstraction remains injectable in the Node low-level runtime, so a future CE artifact can be evaluated without changing model or preprocessing code.
