# KernelPilot

KernelPilot is a source-distributed Visual Studio Code extension for inspecting C/C++ and CUDA code, preparing CUDA optimization candidates, validating outputs, and measuring performance. It keeps source changes, correctness checks, benchmark timings, and profiler results separate so that compiling or seeing a lower median is not mistaken for correctness or a stable speedup.

The extension source is in [`rogowskikernelpilot/`](rogowskikernelpilot/). There is no Marketplace listing, published VSIX, or license file. The project and CUDA workflows are experimental and depend on the selected harness, compiler, driver, GPU, and isolation support.

## What KernelPilot does

- **Analyze and explain:** Clang-backed C/C++ source analysis, editor selection explanations, AI-assisted review, and CUDA code help. Static findings are hypotheses, not GPU measurements.
- **Prepare CUDA changes:** Convert supported code to CUDA or CPU C++, or ask for an optimization proposal for an existing `.cu`. The original source is preserved; proposals and diffs are separate artifacts.
- **Benchmark and profile:** Run supported benchmark adapters or a user-authored CUDA experiment harness. **Profile Bottlenecks** uses the C/C++ analysis/benchmark path or instruments a temporary copy of an existing CUDA translation unit and times only launches the original program reaches.
- **Validate correctness:** Compare reference and CUDA executables through an explicit shared input/output protocol, or validate original/candidate through a separately authored experiment harness.
- **Compare reports:** Select existing baseline and candidate JSON reports for an evidence-based timing, correctness, sanitizer, and NCU comparison. Source reports remain unchanged.

CPU-only analysis and supported CPU benchmarks do not require an NVIDIA GPU. AI assistance requires a configured provider. CUDA compilation needs the NVIDIA CUDA Toolkit; CUDA execution also needs a working driver/GPU. Runtime candidate execution requires supported Linux Bubblewrap filesystem/process isolation. The compiler runs with limits and consent but is not filesystem/network sandboxed. GPU workloads share the device and may hang or exhaust device memory; do not run untrusted kernels. Read [architecture and security boundaries](docs/architecture.md).

## Requirements

| Workflow | Requirements |
|---|---|
| Develop the extension | VS Code 1.140 or later in the 1.x line, Node.js, and npm. |
| Native C/C++ analyzer | CMake and Clang/LLVM development packages, or a compatible binary configured with `kernelpilot.analyzerPath`. |
| AI commands | A reachable Ollama service or an HTTPS OpenAI-compatible chat-completions endpoint and provider credential. AI is optional for analysis and non-AI workflows. |
| CUDA compile | NVIDIA CUDA Toolkit with `nvcc`; project include paths, defines, language standard, libraries, and architecture may need configuration. |
| CUDA runtime/timing | A visible NVIDIA GPU and compatible driver. Candidate execution additionally needs supported Linux Bubblewrap isolation. |
| NVIDIA hardware counters | Nsight Compute CLI (`ncu`); collection may also require administrator-managed counter access. KernelPilot does not change driver or system permissions. |

## Install and start

Clone and build the extension package:

```sh
git clone https://github.com/OliwierRogowski/KernelPilot.git
cd KernelPilot/rogowskikernelpilot
npm ci
npm run compile
```

Open `rogowskikernelpilot/` in VS Code and press **F5** to start the Extension Development Host. To build the optional native analyzer, install CMake and Clang/LLVM development files, then run:

```sh
cmake -S native-analyzer -B native-analyzer/build
cmake --build native-analyzer/build --target kernelpilot-analyzer
```

### First CUDA correctness check

This included example compares a CPU reference with a correct or intentionally faulty CUDA executable. From the repository root:

```sh
cd rogowskikernelpilot/examples/cuda-result-validation
g++ -std=c++17 -O2 reference.cpp -o reference
nvcc -std=c++17 -O2 -lineinfo cuda_transform_correct.cu -o cuda-correct
nvcc -std=c++17 -O2 -lineinfo cuda_transform_buggy.cu -o cuda-buggy
```

In the Extension Development Host run **KernelPilot: Validate CUDA Results Against Reference**. Select `reference`, then `cuda-correct` (expected `passed`) or `cuda-buggy` (expected `failed`). Supply `[]` for both argument lists and keep the generated seed to reproduce the inputs. CUDA runtime and Bubblewrap isolation must be available. The protocol, comparison rules, and report sample are in the [example guide](rogowskikernelpilot/examples/cuda-result-validation/README.md).

## Configure an AI provider (optional)

Copy the root template and edit the private local file:

```sh
cd /path/to/KernelPilot
cp .env.example .env
```

Set `KERNELPILOT_AI_PROVIDER` to `ollama` or `openai-compatible`, then configure the endpoint, model, and (when needed) key. `.env` is Git-ignored. Never put credentials in `.env.example`, code, reports, issues, or commits. Run **KernelPilot: Test configured model connection** to verify a live request. See [configuration](docs/configuration.md) for precedence and supported settings.

## Command Palette

Commands registered by the current extension manifest:

| Command | Purpose |
|---|---|
| **KernelPilot: Explain selected code** | Explain the editor selection through the configured model. |
| **KernelPilot: Analyze current C/C++ file** | Show Clang-backed source analysis; does not run the program. |
| **KernelPilot: Analyze and propose optimization for existing .cu** | Create a separate CUDA candidate, experiment metadata, and source diff. |
| **KernelPilot: Compile, validate, and benchmark CUDA experiment** | Build original and candidate against the configured independent harness, then validate its correctness/timing records. |
| **KernelPilot: Export CUDA experiment report** | Export experiment and validation details as Markdown. |
| **KernelPilot: Review code with local AI** | Request an advisory model review. |
| **KernelPilot: Test configured model connection** | Make a live request to the configured provider. |
| **KernelPilot: Benchmark file or selection** | Run a supported workload adapter; arbitrary programs are not automatically benchmarkable. |
| **KernelPilot: Profile Bottlenecks** | Profile C/C++ through its benchmark path or time reached launches in a temporary copy of existing CUDA source. |
| **KernelPilot: Run Nsight Compute and Sanitizer** | Optionally run `ncu` profiling and selected Compute Sanitizer checks on an already built executable. Disabled unless `kernelpilot.nvidiaDiagnosticsEnabled` is enabled. |
| **KernelPilot: Check NVIDIA Diagnostics Environment** | Check tool/version and GPU/driver visibility and query available counter capabilities. Does not launch the user's kernel. |
| **KernelPilot: Validate CUDA Results Against Reference** | Run two executables sequentially with the same deterministic input and compare typed indexed outputs. |
| **KernelPilot: Compare Optimization Reports** | Compare baseline/candidate JSON reports and export a new JSON or Markdown summary. |
| **KernelPilot: Convert file or selection to CUDA** | Request a CUDA translation and perform available structural/compiler checks. |
| **KernelPilot: Convert CUDA file or selection to CPU** | Request a CPU C++ translation and syntax-check it. Syntax checking is not behavioral validation. |
| **KernelPilot: CUDA programming help** | Open the CUDA help view. |

The extension also retains a **Hello World** sample command for development smoke checks.

## Benchmarks and profiling

Benchmark paths have different workloads and timer boundaries. Check the report's correctness state, sizes, timer scope, number of samples, and environment before comparing results. The experiment harness owns its reference and timing procedure; KernelPilot checks protocol structure but cannot prove the harness is independent or semantically correct.

**Profile Bottlenecks** does not inject a caller or infer grid/block/input parameters. For an existing `.cu`/`.cuh`, it instruments a temporary copy, uses CUDA events around original launches, and reports only launches actually reached by the program. It does not independently validate numerical output. A `.cu` file is CUDA source, not an executable; the `.ncu-rep` raw report is created only if Nsight Compute successfully exports it.

See [benchmarking and interpretation](docs/benchmarking.md), [profiling details](docs/profiling.md), and [the CUDA GPU setup guide](NVIDIA_GPU.md).

## NVIDIA Nsight Compute and Compute Sanitizer

NVIDIA diagnostics are optional and disabled by default. Configure the paths, timeout, and report directory with `kernelpilot.ncuPath`, `kernelpilot.computeSanitizerPath`, `kernelpilot.nvidiaDiagnosticsTimeoutMs`, and `kernelpilot.nvidiaDiagnosticsReportDirectory`. Select a kernel with `kernelpilot.ncuKernelRegex`, limit profile launches with `kernelpilot.ncuLaunchCount`, and optionally request metric names with `kernelpilot.ncuMetrics`. Choose `memcheck`, `racecheck`, `initcheck`, and/or `synccheck` in `kernelpilot.computeSanitizerTools`. The environment command reports the detected versions and advertised capabilities. A metric list or successful query is not evidence that profiling a kernel or exporting a report will work.

**Verification limitation:** in the previously checked NVIDIA RTX A2000 Laptop GPU environment, an actual Nsight Compute profile returned `ERR_NVGPUCTRPERM`. Hardware-counter collection and successful `.ncu-rep` export therefore remain **unverified** there. Parser tests and CLI fakes are not real GPU profiling. KernelPilot does not alter driver configuration or counter permissions. See [NVIDIA diagnostic details](docs/profiling.md#nsight-compute-and-compute-sanitizer) and the [sanitizer fixtures](rogowskikernelpilot/examples/nvidia-sanitizer/README.md).

## Result validation and report comparison

**KernelPilot: Validate CUDA Results Against Reference** requires both programs to implement KernelPilot's documented `KP_INPUT_V1`/`KP_RESULT_V1` contract; arbitrary `.cu` files are not assumed to produce comparable output. Integer results compare exactly. Floating-point results use `absError <= absoluteTolerance + relativeTolerance * abs(reference)`, with explicit NaN, infinity, length, and type handling. Validation is run outside benchmark timing and reports `passed`, `failed`, `not-run`, or `tool-error`.

**KernelPilot: Compare Optimization Reports** shows timing medians, counts, min–max spread, speedup, percentage time change, correctness, sanitizer states, and matching NCU data. It uses a deterministic independent bootstrap of raw sample medians when there are at least five valid samples per report. Large uncertainty or a practical change below `kernelpilot.reportComparisonPracticalChangePercent` produces an inconclusive result. Different GPU/input/timing scopes make reports incomparable; missing metadata stays uncertain. A failed candidate is never recommended. This comparison does not require access to NCU counters.

## Reports and configuration

Workspace artifacts are written under `.kernelpilot/` by the corresponding workflow, commonly `experiments/`, `profiles/`, `nvidia-diagnostics/`, or `cuda-result-validation/`. Report files include raw measurements or outputs where available; inspect and redact local paths, source excerpts, or program output before sharing. The report comparison exports a separate file and leaves both selected reports unchanged.

Important optional settings include:

- CUDA: `kernelpilot.cudaCompiler`, `kernelpilot.cudaArchitecture`, `kernelpilot.cudaValidationHarness`, `kernelpilot.cudaProfileTranslationUnit`, and the profile warmup/repetition settings.
- Result validation: `kernelpilot.cudaResultValidationInputCount`, `kernelpilot.cudaResultValidationTimeoutMs`, `kernelpilot.cudaResultValidationAbsoluteTolerance`, `kernelpilot.cudaResultValidationRelativeTolerance`, and `kernelpilot.cudaResultValidationReportDirectory`.
- Report comparison: `kernelpilot.reportComparisonPracticalChangePercent` (default 3%).
- NVIDIA diagnostics: `kernelpilot.nvidiaDiagnosticsEnabled`, tool paths, timeout/report directory, NCU kernel/launch/metric settings, and selected sanitizer tools.

See [all configuration details](docs/configuration.md).

## Tests, limitations, and support

From `rogowskikernelpilot/`, run:

```sh
npm run check-types
npm run lint
npm run compile
npm run compile-tests
npm test
```

The extension test suite needs a VS Code test binary; CUDA tests run only when the toolchain/device are available, and model-backed benchmark tests are opt-in. Skipped tests are not passes. See [Contributing](CONTRIBUTING.md) for the test binary override and [the current verification report](TEST_REPORT.md) for the latest run. Other limits and troubleshooting steps are in [Troubleshooting](docs/troubleshooting.md).

Open a [GitHub issue](https://github.com/OliwierRogowski/KernelPilot/issues) with the exact command, OS/VS Code/compiler versions, non-secret diagnostics, and a small reproducer. Remove API keys, private source, personal data, and sensitive paths first.

## Documentation

- [Getting started](docs/getting-started.md)
- [Configuration](docs/configuration.md)
- [Benchmarking and interpreting results](docs/benchmarking.md)
- [Profiling and NVIDIA diagnostics](docs/profiling.md)
- [CUDA GPU setup](NVIDIA_GPU.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Architecture and security](docs/architecture.md)
- [Contributing](CONTRIBUTING.md)
- [Unreleased changes](CHANGELOG.md)
- [Verification report](TEST_REPORT.md)
- [Demo walkthrough](DEMO.md)
- [Audit notes](KERNELPILOT_AUDIT.md)
