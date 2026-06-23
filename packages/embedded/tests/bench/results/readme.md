# Benchmark Results

This folder is for small, reviewed benchmark summaries that should survive local cleanup.

Raw scratch JSON stays under `tests/bench/.out/`, which is ignored because full matrix runs can
produce many large files. A run used for a baseline, review, or release decision must also be
archived as deterministic gzip under `tests/bench/results/artifacts/` and summarized here with its
command, commit SHA, environment, and archive path.
