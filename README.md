# KernelPilot

KernelPilot is a Visual Studio Code extension for inspecting C/C++ and CUDA code, preparing AI-assisted CUDA changes, and measuring implementations under explicit correctness checks. Its main job is to help you examine a proposed GPU implementation: it keeps the original code, proposed code, validation result, and timing report distinct so that a successful build or a lower timing is not mistaken for proof of correctness or speedup.

## What the extension does

KernelPilot provides three related workflows:

1. **Understand code.** Analyze a C/C++ file with the native Clang-backed analyzer, ask the configured AI provider to explain selected code or review a file, and inspect detected CUDA launch and source properties. Static findings are hints to investigate; they are not runtime measurements.
2. **Create a CUDA proposal.** Convert selected C/C++ code to CUDA, convert CUDA code back to CPU C++, or ask for an optimization proposal for an existing `.cu` file. For an existing CUDA optimization, the extension saves a separate candidate and diff; it does not overwrite the user's original source. AI-generated code may be wrong and is not considered validated just because it compiles.
3. **Check and measure.** Compile and run original and candidate implementations using a configured, independently authored CUDA validation harness. The harness supplies test inputs, correctness checks, and timing records. The extension validates those records and reports comparable samples where available. The direct **Profile Bottlenecks** command is a separate path: for existing CUDA it instruments a copy of the user's source and times kernel launches that the original program actually executes.

The benchmark and profiler reports answer different questions. A benchmark harness can test whether two implementations produce matching outputs and measure phases it explicitly reports. Direct CUDA source profiling records events around existing launches, but does not independently verify program output or invent calls to kernels that the program does not reach. C/C++ profiling uses its own source-analysis and benchmark path. Missing or incomparable metrics remain unresolved; KernelPilot does not manufacture a CPU/GPU speedup.

The extension can use Ollama or an OpenAI-compatible chat-completions endpoint for explanation, review, and code proposals. AI is optional for native analysis and supported non-AI measurement paths. Model output is advisory and must be reviewed.

The product name is **KernelPilot**. Its extension package currently lives in the legacy-named [`rogowskikernelpilot/`](rogowskikernelpilot/) directory. The repository is source-only: there is no published Marketplace listing or VSIX release. It has no license file, so no reuse license is implied.

The workflows are experimental and depend on the selected algorithm, harness, compiler, and hardware. See [known limits](docs/troubleshooting.md), [benchmark semantics](docs/benchmarking.md), and [profiling details](docs/profiling.md).

## Requirements

| Use | Requirements |
|---|---|
| Develop and run the extension | VS Code 1.140 or later in the 1.x line; Node.js and npm for installing dependencies and running development scripts. |
| Native C/C++ analysis | CMake plus Clang/LLVM development packages to build `native-analyzer`; alternatively set `kernelpilot.analyzerPath` to a compatible analyzer executable. |
| AI assistance | A reachable Ollama server, or an HTTPS OpenAI-compatible chat-completions endpoint and a credential accepted by that provider. |
| Compile CUDA | NVIDIA CUDA Toolkit with `nvcc`; project include paths, defines, C++ standard, and architecture may need configuration. |
| Execute and measure CUDA | A usable NVIDIA driver and GPU visible to the process. Runtime candidate execution also needs supported Linux Bubblewrap filesystem/process isolation; without it, execution is refused. |

CPU-only source analysis and CPU benchmark paths do not need an NVIDIA GPU. CUDA compiler execution is resource-limited and requires consent, but is **not** filesystem/network sandboxed. GPU execution shares the physical device and is not safe for untrusted kernels. Read [architecture and security](docs/architecture.md) before running code you do not trust.

## Install for development

The repository does not currently publish a Marketplace extension or VSIX. To run the source version:

```sh
git clone https://github.com/OliwierRogowski/KernelPilot.git
cd KernelPilot/rogowskikernelpilot
npm ci
npm run compile
```

Open the extension package directory as a VS Code workspace and press **F5** to launch the Extension Development Host. Detailed setup is in [Getting started](docs/getting-started.md).

## Configure an AI provider

Copy the repository-root example and add a key issued by your provider:

```sh
cp .env.example .env
```

Set `KERNELPILOT_AI_PROVIDER` to `ollama` or `openai-compatible`, then set the base URL, model, and optional key. `.env` is ignored by Git; never put a real credential in `.env.example`, source code, logs, or a commit. See [configuration](docs/configuration.md) for precedence, supported variables, endpoint behavior, and CUDA compiler settings. Use **KernelPilot: Test configured model connection** to verify a live response.

## Commands

| Command Palette name | What it does |
|---|---|
| `KernelPilot: Explain selected code` | Ask the configured model to explain the editor selection. |
| `KernelPilot: Analyze current C/C++ file` | Parse the active C/C++ source with the native analyzer and show structural and diagnostic findings. It does not execute the program. |
| `KernelPilot: Analyze and propose optimization for existing .cu` | Analyze an existing CUDA source and save an AI-generated candidate, original snapshot, and experiment metadata separately from the source file. |
| `KernelPilot: Compile, validate, and benchmark CUDA experiment` | Build and run the original and candidate with the configured independent CUDA harness; check its correctness records and collect the timing fields it reports. Requires a working CUDA toolchain and GPU for execution. |
| `KernelPilot: Export CUDA experiment report` | Export the current experiment metadata and validation/measurement results as Markdown. |
| `KernelPilot: Review code with local AI` | Request an advisory review using the configured provider. |
| `KernelPilot: Test configured model connection` | Make a real request to the configured endpoint. |
| `KernelPilot: Benchmark file or selection` | Run a supported benchmark adapter for the selected algorithm or active file. Workload coverage and CPU/GPU phases depend on the selected path; unsupported arbitrary programs are not automatically benchmarkable. |
| `KernelPilot: Profile Bottlenecks` | Profile C/C++ through its analysis/benchmark path, or instrument a copy of an existing `.cu`/`.cuh` program. CUDA kernel samples are emitted only for launches reached by the original program. |
| `KernelPilot: Convert file or selection to CUDA` | Ask the configured model for a CUDA translation of the selection or supported file, then run available source/compiler checks. The result is a candidate that still needs runtime correctness validation. |
| `KernelPilot: Convert CUDA file or selection to CPU` | Ask the configured model for a CPU C++ translation and syntax-check the generated file with the configured CPU compiler. Syntax checking does not establish behavioral equivalence. |
| `KernelPilot: CUDA programming help` | Open the CUDA help view. |

For exact workflows and caveats, see [Profiling](docs/profiling.md) and [Getting started](docs/getting-started.md).

## Typical workflow

1. Analyze a C/C++ or CUDA source and review the evidence. Static findings are hypotheses, not runtime bottleneck measurements.
2. Request a conversion or CUDA optimization proposal. Inspect the generated candidate and diff; the original file is kept separate.
3. Configure a deterministic, independently authored correctness harness. Do not use model output as the only oracle.
4. Compile and run the original and candidate after reviewing the consent prompts. A successful compile alone is not a correctness result.
5. Compare only matching sizes, sample IDs, correctness results, and timer scopes. Export the experiment report if useful.
6. Use **KernelPilot: Profile Bottlenecks** for measured hot spots. For existing CUDA, confirm the original program really calls the launches; a declared kernel or unreachable launch site produces no kernel timing.

## Documentation

- [Getting started](docs/getting-started.md)
- [Configuration](docs/configuration.md)
- [Benchmarking and interpreting results](docs/benchmarking.md)
- [Profiling C++, `.cu`, and `.cuh`](docs/profiling.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Architecture and security boundaries](docs/architecture.md)
- [Contributing](CONTRIBUTING.md)
- [Unreleased changes](CHANGELOG.md)
- [Verification report](TEST_REPORT.md)
- [CUDA GPU setup notes](NVIDIA_GPU.md)
- [Demo walkthrough](DEMO.md)
- [Current audit notes](KERNELPILOT_AUDIT.md)

## Report a problem

Open a [GitHub issue](https://github.com/OliwierRogowski/KernelPilot/issues) with the command name, operating system, VS Code version, extension version or commit, relevant compiler/provider versions, and the exact non-secret error. Include a small reproducible source sample when possible. Remove API keys, tokens, private source, personal data, and sensitive paths from logs before attaching them. See [Troubleshooting](docs/troubleshooting.md) for information that helps diagnose provider, compiler, isolation, and profiling failures.
