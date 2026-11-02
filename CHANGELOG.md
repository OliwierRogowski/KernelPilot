# Changelog

This file records project changes not yet included in a tagged release. The repository has no release tags. The current work targets the existing `github-export` branch; no Marketplace or VSIX release is claimed.

## Unreleased

### Added

- A shared AI configuration path for Ollama and a limited OpenAI-compatible chat-completions endpoint, including endpoint validation, bounded retries for truncated output, response diagnostics, and tests for error handling.
- CUDA source analysis and a proposal workflow that keeps the original `.cu`, candidate, and experiment manifest separate, shows a diff, and requires an independently authored validation harness for correctness/performance claims.
- Structured CPU/CUDA benchmark helpers and parsers for per-size correctness, CPU compute/end-to-end metrics, CUDA transfer/kernel/end-to-end metrics where supported, sample pairing, and conservative CPU/GPU interpretation.
- Direct `KernelPilot: Profile Bottlenecks` support for existing `.cu` and `.cuh` sources. Instrumentation is generated in a temporary `profiled_original.cu`, uses CUDA events on existing launch streams, and records launch/copy site and invocation metadata.
- Optional Nsight Compute and Compute Sanitizer workflows, an NVIDIA diagnostics environment check, and raw diagnostic artifact retention.
- CUDA output validation against a separately compiled reference using deterministic shared inputs, typed indexed output records, exact integer comparisons, and configurable absolute/relative floating-point tolerances.
- Saved optimization report comparison with provenance checks, raw-sample uncertainty estimates, correctness-gated recommendations, and JSON/Markdown export.
- Small CUDA examples for reference validation and the four Compute Sanitizer tools.
- Documentation for setup, configuration, benchmark semantics, direct profiling, troubleshooting, architecture/security, and contributing.

### Changed

- CUDA candidate validation rejects incomplete protocols, missing device/runtime evidence, mismatched cases, malformed checksums, and regressions instead of treating compilation as validation.
- CUDA conversion performs structural/type checks and bounded compile-repair attempts while preserving original source separately.
- Measurement interpretation pairs sample IDs and compatible phases, describes uncertainty, and avoids claiming hardware bottlenecks or a general crossover threshold from timing alone.
- Direct CUDA source profiling now emits a finalization counter and compares it with parsed samples. It distinguishes no runtime launch from event/finalization/parser failures, and flushes pending records before `cudaDeviceReset`.
- Ordinary benchmark timing remains separate from profiler and reference-validation runs. Diagnostic and correctness states are recorded independently from performance.

### Fixed

- Provider handling now reports authentication, rate-limit, timeout, malformed, empty, and truncated response states explicitly; credentials echoed by provider errors are redacted in tested paths.
- Fixed-size odd workloads use integer quarter/half/full sizes instead of fractional element counts.
- CUDA profiling records runtime sample identifiers and excludes separate-process warmup outputs from measured samples.

### Known issues and limits

- Direct existing-source profiling reports no samples when the original program does not call the detected launch sites. A kernel declaration or launch inside an unused host wrapper is not execution. It does not invent a caller or workload.
- Direct existing-source profiling does not independently verify numerical correctness. It times kernel invocations and existing `cudaMemcpyAsync` operations; synchronous transfers, allocations, host preparation, and a whole-program end-to-end CUDA timer are not separately provided by that path.
- Nsight Compute depends on GPU/driver counter permissions and installed tool capabilities. The previous RTX A2000 Laptop GPU attempt returned `ERR_NVGPUCTRPERM`; real counter collection and successful `.ncu-rep` export remain unverified. Parser fixtures and fake-tool tests are not real GPU profiling.
- CUDA result validation only applies to programs that implement the documented input/output protocol. It cannot infer comparable outputs from arbitrary `.cu` source files.
- Report comparisons depend on the provenance recorded in the reports and the available timing samples. Missing provenance lowers confidence; small/noisy samples can yield an inconclusive result.
- The CUDA experiment's correctness and timing trust the configured user-owned harness. KernelPilot validates its output protocol but cannot prove the harness's oracle or timer boundaries are independent and semantically correct.
- The compiler is resource-limited and requires consent but is not filesystem/network sandboxed. Candidate runtime isolation is platform-dependent and requires supported Linux Bubblewrap namespaces; GPU hang and device-memory exhaustion are not guaranteed to be contained.
- No Marketplace/VSIX release or license has been established. No release date or version tag is claimed.

See [TEST_REPORT.md](TEST_REPORT.md) for current verification results and the distinction between real GPU runs, fake-tool tests, and parser fixtures.
