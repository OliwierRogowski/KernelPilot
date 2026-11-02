# CUDA result validation example

This example compares a CUDA candidate against a CPU reference. It is an explicit validation run, outside any benchmark timer. Both programs read the same saved input file passed as `--kernelpilot-input <path>` and emit typed result records.

## Build

```sh
g++ -std=c++17 -O2 reference.cpp -o reference
nvcc -std=c++17 -O2 -lineinfo cuda_transform_correct.cu -o cuda-correct
nvcc -std=c++17 -O2 -lineinfo cuda_transform_buggy.cu -o cuda-buggy
```

In the KernelPilot Extension Development Host run **KernelPilot: Validate CUDA Results Against Reference**. Select `reference` and then `cuda-correct` (expected `passed`) or `cuda-buggy` (expected `failed`). Enter `[]` for both argument prompts and keep the generated seed to reproduce a run. The extension uses the configured input count and tolerances. It writes a JSON result, raw program output and the shared input artifact. The report action can attach the validation to an existing CUDA profile/benchmark JSON. Validation runs are separate from benchmark timers and do not add their execution time to a performance report.

## Contract

KernelPilot creates one deterministic `KP_INPUT_V1` text file containing the seed, `float64` input type, count and indexed values. It passes the same file to both programs as `--kernelpilot-input <path>`; each program must read it instead of independently generating inputs. Programs emit one header `KP_RESULT_V1,<type>,<count>` followed by exactly one `KP_VALUE,<index>,<value>` line for every contiguous index starting at zero. Supported result types are `int32`, `uint32`, `int64`, `uint64`, `float32` and `float64`. Float special values use `NaN`, `+Inf` and `-Inf`.

Integer results compare exactly. Floating-point results pass an element if `abs(candidate-reference) <= absTolerance + relTolerance * abs(reference)`. Two NaNs compare equal; infinities compare equal only when their signs match. A finite/special mismatch fails. Different result types fail without numerical comparison; different lengths fail and missing indices are recorded. Relative error is unavailable where the reference is zero and the absolute difference is nonzero. The JSON contains the seed, input hash/path, per-program output, mismatch count, first mismatches and maximum computable errors.

The command runs each executable once, sequentially, with the same working directory, input artifact and deterministic seed. It uses direct argument arrays (no shell), process timeout/cancellation, and the project's filesystem/process isolation. `passed` verifies correctness only; the report never claims a speedup. `failed` sets `optimizationAssessment.disposition` to `incorrect` and never permits a speedup recommendation. Reference/candidate launch errors, timeouts, cancellation, and invalid protocol output are not mislabeled as arithmetic failures.

The generated JSON, raw output, and input file are saved under the configured `kernelpilot.cudaResultValidationReportDirectory` (default `.kernelpilot/cuda-result-validation` in the active workspace). A run that fails to start or times out is `tool-error` or `not-run`, not `failed`. The shared file's seed and SHA-256 are included so the generated input can be audited. See the [comparison and report guide](../../../docs/benchmarking.md#cuda-result-correctness-validation).
