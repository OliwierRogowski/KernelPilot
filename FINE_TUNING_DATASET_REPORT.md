# `fine-tuning-2.json` data quality report

Validated with the repository's Python standard-library script `scripts/validate_finetuning_dataset.py` on 2026-10-21.

## Observed checks

- JSON parses as an array: **pass**.
- Records: **31** (the original 22 plus nine new examples).
- Messages: **95**; all records have a non-empty system message, alternating user/assistant turns, and end with an assistant response.
- Category coverage: **29 categories**.
- Distinct user prompts: **32 / 32**; exact duplicate prompts: **0**.
- Distinct assistant responses: **32 / 32**; exact duplicate assistant responses: **0**.
- Added coverage: floating-point edge cases/tolerances, asynchronous CUDA runtime errors, independent correctness oracles, nvcc compilation errors, noisy benchmarks, rejecting slower proposals, missing GPU/driver reporting, architecture/toolkit mismatch, and profiler evidence.
- Metadata `source` is marked `curated`; authorship provenance, license suitability, and subject-matter review are not independently verified.

## Format and limits

The data uses a provider-neutral JSON array of conversation objects with a `messages` array (`system` / `user` / `assistant`) plus category metadata. The validator can emit one JSON object per line with `--jsonl`, but that is a generic serialization only. It is not asserted to match any specific Meta/partner training service, tokenizer, chat template, fine-tuning schema, or model card requirements. Confirm the selected service's exact schema before submitting it.

No model training or fine-tuning was performed. Fine-tuning is optional; first compare a fixed evaluation set using a strong system prompt, structured output validation, compile/correctness gates, and honest measurements. These 31 records are a small manually curated seed set, not evidence of a model-quality improvement. Have CUDA and Polish-language reviewers check technical accuracy and provenance before external use.
