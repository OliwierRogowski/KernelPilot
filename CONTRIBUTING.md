# Contributing

Thanks for helping improve KernelPilot. Contributions should keep generated proposals, compile results, correctness checks, and performance claims distinct. Do not claim a speedup from compilation alone or from incomparable timer scopes.

## Development setup

1. Install VS Code 1.140 or later, Node.js, and npm.
2. Clone the repository and work from the extension directory:

   ```sh
   git clone https://github.com/OliwierRogowski/KernelPilot.git
   cd KernelPilot/rogowskikernelpilot
   npm ci
   ```

3. Open this directory in VS Code. Use **F5** to run the Extension Development Host.
4. For CUDA runtime integration tests, install a compatible NVIDIA CUDA Toolkit/driver and use Linux with the supported Bubblewrap isolation preflight. Model-backed integration tests need an explicitly configured reachable provider; GPU/model tests are not replaced with mocks and may be skipped when prerequisites are absent.

## Checks

Run before submitting changes:

```sh
npm run check-types
npm run lint
npm run compile
npm run compile-tests
npm test
```

If the `code` wrapper cannot launch the test application, point the VS Code test runner to an application binary:

```sh
KERNELPILOT_VSCODE_PATH=/path/to/VSCode/application npm test
```

The model-backed benchmark tests are opt-in with `KERNELPILOT_RUN_MODEL_BENCHMARK_TESTS=1` and require a configured provider/model. GPU tests require an actual usable device. Report skipped tests as skipped; do not describe them as passed.

## Change guidelines

- Preserve the user's original source. Write candidates and profiling instrumentation to separate artifacts or temporary copies.
- Use independent, deterministic correctness tests for algorithm changes. A model-generated expected result is not an independent oracle.
- Keep timing boundaries explicit and compare only equivalent work, workloads, and sample IDs.
- Do not synthesize GPU timings, successful runtime records, or a CPU/GPU speedup when required evidence is missing.
- Treat source analysis as a hypothesis until compiler/runtime/profiler evidence confirms it.
- Keep user-facing text, generated report headings, and diagnostics in English.
- Do not put API keys, private source, local profiles, build outputs, or temporary files into a commit.

## Pull requests and bug reports

Use a focused branch and explain the behavior changed, evidence gathered, tests run, and any skipped checks. Include the exact command/compiler and a minimal reproducer for bugs. Remove credentials, private code, personal information, and sensitive local paths from logs. The repository currently has no `LICENSE` file; do not add one without the maintainer's choice.
