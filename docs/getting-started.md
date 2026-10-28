# Getting started

KernelPilot is currently run from source. The repository does not yet publish a Marketplace extension or a VSIX release.

## Requirements

- VS Code 1.140 or later in the 1.x release line.
- Node.js and npm to install and build the extension package.
- An AI provider only for model-backed commands.
- CUDA Toolkit and `nvcc` to compile CUDA code. A working NVIDIA driver and GPU are additionally required for CUDA execution and timing.
- Linux Bubblewrap filesystem/process namespaces for commands that execute candidate programs. The extension refuses runtime execution when the required isolation preflight is unavailable.

## Run the extension from source

```sh
git clone https://github.com/OliwierRogowski/KernelPilot.git
cd KernelPilot/rogowskikernelpilot
npm ci
npm run compile
cmake -S native-analyzer -B native-analyzer/build
cmake --build native-analyzer/build --target kernelpilot-analyzer
```

The native analyzer build needs CMake and Clang/LLVM development packages. If you already have a compatible `kernelpilot-analyzer` executable, set `kernelpilot.analyzerPath` instead. Open the `rogowskikernelpilot/` directory in VS Code and press **F5** (Run Extension). The development host uses `dist/extension.js`, produced by the compile command.

Useful project checks:

```sh
npm run check-types
npm run lint
npm run compile
npm run compile-tests
npm test
```

`npm test` launches a VS Code extension host. See [Contributing](../CONTRIBUTING.md) for the VS Code binary override and notes about GPU- and model-dependent tests.

## First CPU/C++ run

1. Open a C or C++ source file.
2. Run **KernelPilot: Analyze current C/C++ file** to inspect the source.
3. Optionally run **KernelPilot: Review code with local AI** or explain a selection after configuring a provider.
4. Run **KernelPilot: Benchmark file or selection** or **KernelPilot: Profile Bottlenecks**. Follow each consent prompt. Inspect the output and report for the exact workload, correctness state, sample count, and timer scope.

Benchmark paths are not universal: some target algorithms require an adapter or a harness, and a comparison is unresolved when matching measurements are unavailable.

## First CUDA experiment

1. Open an existing `.cu` file and run **KernelPilot: Analyze and propose optimization for existing .cu**.
2. Review the analysis, separate `candidate.cu`, manifest, and VS Code diff. This step proposes a change; it does not prove it is correct or faster.
3. Configure `kernelpilot.cudaValidationHarness` with an independent harness that includes the selected source using `KERNELPILOT_KERNEL_SOURCE` and follows the `KP_RESULT,<case>,PASS|FAIL,<median_ms>,<p95_ms>` protocol.
4. Run **KernelPilot: Compile, validate, and benchmark CUDA experiment**. Review and accept the compile/run consent prompts. A usable GPU is needed for runtime checks and timing.
5. Export the experiment record with **KernelPilot: Export CUDA experiment report**.

For direct profiling of existing code, including `.cuh` caller selection and the zero-runtime-launch case, see [Profiling](profiling.md).

## VS Code settings

Open Settings and search for `KernelPilot`. The model provider, endpoint, and model can also be provided through environment variables or the repository-root `.env`. CUDA compiler, architecture, harness, calling translation unit, and profile repetition settings are described in [Configuration](configuration.md).

## Distribution status

There is no Marketplace listing or published VSIX. `npm run package` validates and creates the production JavaScript bundle; it does not itself invoke `vsce` or publish an installable package.
