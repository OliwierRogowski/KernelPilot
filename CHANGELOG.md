# Changelog

This file records unreleased work against the last published repository state. The repository has no release tags. The documented comparison point is commit `0cf7db9` (`Prepare KernelPilot hackathon export`), which is the `origin/main` tip observed during this preparation. Current working-tree changes have not been released.

## Unreleased

### Added

- A shared AI configuration path for Ollama and a limited OpenAI-compatible chat-completions endpoint, including endpoint validation, bounded retries for truncated output, response diagnostics, and tests for error handling.
- CUDA source analysis and a proposal workflow that keeps the original `.cu`, candidate, and experiment manifest separate, shows a diff, and requires an independently authored validation harness for correctness/performance claims.
- Structured CPU/CUDA benchmark helpers and parsers for per-size correctness, CPU compute/end-to-end metrics, CUDA transfer/kernel/end-to-end metrics where supported, sample pairing, and conservative CPU/GPU interpretation.
- Direct `KernelPilot: Profile Bottlenecks` support for existing `.cu` and `.cuh` sources. Instrumentation is generated in a temporary `profiled_original.cu`, uses CUDA events on existing launch streams, and records launch/copy site and invocation metadata.
- Documentation for setup, configuration, benchmark semantics, direct profiling, troubleshooting, architecture/security, and contributing.

### Changed

- CUDA candidate validation rejects incomplete protocols, missing device/runtime evidence, mismatched cases, malformed checksums, and regressions instead of treating compilation as validation.
- CUDA conversion performs structural/type checks and bounded compile-repair attempts while preserving original source separately.
- Measurement interpretation pairs sample IDs and compatible phases, describes uncertainty, and avoids claiming hardware bottlenecks or a general crossover threshold from timing alone.
- Direct CUDA source profiling now emits a finalization counter and compares it with parsed samples. It distinguishes no runtime launch from event/finalization/parser failures, and flushes pending records before `cudaDeviceReset`.
- User-facing extension command, progress, and profile-report text is being standardized in English.

### Fixed

- Provider handling now reports authentication, rate-limit, timeout, malformed, empty, and truncated response states explicitly; credentials echoed by provider errors are redacted in tested paths.
- Fixed-size odd workloads use integer quarter/half/full sizes instead of fractional element counts.
- CUDA profiling records runtime sample identifiers and excludes separate-process warmup outputs from measured samples.

### Known issues and limits

- Direct existing-source profiling reports no samples when the original program does not call the detected launch sites. A kernel declaration or launch inside an unused host wrapper is not execution. It does not invent a caller or workload.
- Direct existing-source profiling does not independently verify numerical correctness. It times kernel invocations and existing `cudaMemcpyAsync` operations; synchronous transfers, allocations, host preparation, and a whole-program end-to-end CUDA timer are not separately provided by that path.
- The CUDA experiment's correctness and timing trust the configured user-owned harness. KernelPilot validates its output protocol but cannot prove the harness's oracle or timer boundaries are independent and semantically correct.
- The compiler is resource-limited and requires consent but is not filesystem/network sandboxed. Candidate runtime isolation is platform-dependent and requires supported Linux Bubblewrap namespaces; GPU hang and device-memory exhaustion are not guaranteed to be contained.
- No Marketplace/VSIX release or license has been established. No release date or version tag is claimed.

### Verification recorded during preparation

- `npm run check-types`, `npm run lint`, `npm run compile`, and `npm run compile-tests` passed.
- Full extension suite on a CUDA-capable Linux host: 94 passed, 7 pending. The pending cases are opt-in model-backed benchmark tests.
- Real NVCC/GPU tests covered matrix multiplication, array reduction, direct `.cu` and `.cuh` profiling, and CUDA event finalization before device reset. The host reported NVIDIA RTX A2000 Laptop GPU, compute capability 8.6, and NVCC 13.4.
- A dedicated profile-command test against the supplied `xxxxx.cu` confirmed that the original `main()` only runs the CPU routine: the finalizer reported zero kernel launches in each measured run. No kernel timing or correctness claim is recorded for that source until an actual caller invokes `sumOfSquaresGPU`.
- A separate live model-backed C++ benchmark regression passed with the configured local Ollama model. No live Meta endpoint result is claimed.
