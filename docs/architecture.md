# Architecture and security boundaries

KernelPilot is a local VS Code extension. It has no hosted backend or project database. The extension package is under `rogowskikernelpilot/`; command orchestration is in `src/extension.ts` and the production JavaScript bundle is `dist/extension.js`.

## Main modules

| Module | Responsibility |
|---|---|
| `extension.ts` | VS Code commands, progress/output UI, compiler/runner orchestration, reports, and experiment interactions. |
| `aiConfig.ts`, `modelProvider.ts` | Resolve model settings and send requests to Ollama or the supported OpenAI-compatible endpoint; validate, bound, and diagnose provider responses. |
| `cudaConversion.ts` | Build conversion prompts, extract candidate CUDA code, validate structural/type evidence, and run bounded compiler repair. |
| `cudaExperiment.ts` | Lexically inspect CUDA sources, preserve immutable experiment inputs, parse model proposals, and render experiment reports. |
| `cudaValidation.ts` | Validate user-harness correctness and benchmark result records, matched cases, speedup policy, and regressions. |
| `cudaProfileConfiguration.ts`, `cudaSourceProfiler.ts` | Resolve direct-profile build flags, find original launch sites, generate a temporary instrumented copy, parse runtime event records, and preserve launch/copy metadata. |
| `benchmarkTarget.ts`, `benchmarkWorkload.ts`, `matrixBenchmarkOracle.ts` | Identify candidate targets/workloads and provide source-anchored test/oracle helpers for supported benchmark paths. |
| `matmulCudaHarness.ts`, `genericCudaHarness.ts`, `cudaMetrics.ts` | Build CUDA benchmark runners and parse validated per-phase timing/correctness protocols. |
| `benchmarkInterpretation.ts`, `bottleneckProfile.ts` | Summarize matched samples and describe measured phase dominance without extrapolating hardware causes from timing alone. |
| `candidateRunner.ts` | Inspect isolation support and execute candidate runtime with reduced environment, limits, timeouts, and Bubblewrap when available. |
| `native-analyzer/` | Small Clang-based C/C++ source analyzer. It is static analysis, not a runtime GPU profiler. |

The modules do not make every source pattern benchmarkable. Unsupported or ambiguous calls, workload parameters, translation units, and protocols should remain unresolved rather than being guessed.

## Typical data flows

### AI-assisted conversion

Editor selection/source → configured provider → source/candidate extraction → structural and compiler checks → separate candidate/diff. The original source is not overwritten by generated code. Model acceptance is not correctness evidence.

### Existing CUDA optimization experiment

Existing `.cu` → lexical inspection and environment probes → original snapshot and manifest → schema/signature-checked proposal saved separately → explicit compile/run consent → original and candidate compiled against the same independent harness → correctness and timing protocol validation → experiment JSON and Markdown report.

### Benchmarks and direct source profiling

CPU/CUDA benchmark paths produce structured records for their particular timers and workload. Matching results are paired by input size and sample ID. Direct existing-CUDA profiling instead generates `profiled_original.cu`, which wraps original launches and (for whole-file scope) existing asynchronous copies with events. Runtime finalization emits structured sample and count records; the extension checks those against parsed samples before creating the report.

### Artifact storage

CUDA experiment snapshots and profile reports are written under the opened workspace's `.kernelpilot/` directory. They may contain source excerpts, output, compiler arguments, device details, and local paths. Treat these files as potentially sensitive and inspect them before sharing.

## Security and trust limits

- `.env` is read by the extension process. API credentials are sent to the configured endpoint in its authorization header; they are not intended for experiment output. Keep them out of tracked files and logs.
- Model output and project source are untrusted input. Compiler commands are passed as argument arrays rather than shell-interpolated command strings, but `nvcc` and the host compiler execute as the current user. They have resource/time limits and consent prompts, not filesystem/network sandboxing.
- Candidate executables run with a reduced environment and resource limits. On supported Linux installations, Bubblewrap filesystem/process isolation is required; runtime is refused when the isolation preflight fails. Network namespace availability is checked separately.
- GPU access is a shared device capability. A kernel can hang, consume device memory, or affect other GPU users. The current design does not promise containment or GPU reset recovery.
- The native Clang analyzer executes locally without the candidate runner's filesystem/network namespace and without its memory cap.
- Static analysis and model suggestions are not security review. The user remains responsible for source trust, harness correctness, and whether reported measurements represent the intended application.

See [Profiling](profiling.md), [Benchmarking](benchmarking.md), and [Troubleshooting](troubleshooting.md) for exact evidence boundaries.
