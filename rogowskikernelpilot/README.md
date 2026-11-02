# KernelPilot extension package

This directory contains the source for the KernelPilot Visual Studio Code extension. The repository currently provides source for local development; it has no Marketplace listing or published VSIX. The extension bundle entry point is `dist/extension.js`.

For feature overview, requirements, first CUDA example, commands, reports, and known hardware-counter limitations, see the [repository README](../README.md). Detailed workflows are in [getting started](../docs/getting-started.md), [configuration](../docs/configuration.md), [benchmarking](../docs/benchmarking.md), and [profiling/NVIDIA diagnostics](../docs/profiling.md).

## Build and debug

```sh
npm ci
npm run compile
```

Open this directory in VS Code and press **F5** to launch the Extension Development Host. To build the optional native C/C++ analyzer, install CMake and Clang/LLVM development packages, then run:

```sh
cmake -S native-analyzer -B native-analyzer/build
cmake --build native-analyzer/build --target kernelpilot-analyzer
```

Run the project checks from this directory:

```sh
npm run check-types
npm run lint
npm run compile
npm run compile-tests
npm test
```

`npm run package` produces a production JavaScript bundle; it does not create a VSIX. CUDA integration tests require the relevant compiler/runtime/GPU and may be skipped when unavailable. Tests using fake NVIDIA CLIs verify parsing and failure handling only, not GPU counter collection. In the last recorded NVIDIA counter attempt, Nsight Compute returned `ERR_NVGPUCTRPERM`; actual NCU metric collection and `.ncu-rep` export remain unverified in that environment.
