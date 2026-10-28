# KernelPilot

This directory contains the KernelPilot Visual Studio Code extension package. The repository is currently distributed as source for local development; there is no Marketplace listing or VSIX release.

For the project overview, source installation, AI configuration, commands, CUDA requirements, benchmark semantics, profiling limits, and security notes, see the [repository README](../README.md) and [documentation index](../docs/getting-started.md).

## Build and debug

```sh
npm ci
npm run compile
```

Open this directory in VS Code and press **F5** to start the Extension Development Host. The entry point is `dist/extension.js`.

The native C/C++ analyzer is a separate executable. Build it when needed with CMake and the Clang/LLVM development packages:

```sh
cmake -S native-analyzer -B native-analyzer/build
cmake --build native-analyzer/build --target kernelpilot-analyzer
```

The extension's `npm run package` script creates a production JavaScript bundle; it does not create or publish a VSIX.
