# KernelPilot verification report

This report records checks run against the current working tree during publication preparation. The source files are changing during this task, so use the final results below rather than older audit notes.

## Environment

- VS Code test application: 1.144.0.
- CUDA device: NVIDIA RTX A2000 Laptop GPU, compute capability 8.6.
- CUDA compiler: NVCC 13.4.
- The CUDA source profiler and benchmark integration tests ran on the real device; no CPU simulation was used for those GPU tests.

## Checks run

| Check | Result |
|---|---|
| `npm run check-types` | Passed. |
| `npm run lint` | Passed. |
| `npm run compile` | Passed. |
| `npm run compile-tests` | Passed. |
| `git diff --check` | Passed during the code change review. |
| Full VS Code extension suite (`npm test`) | 94 passed, 7 pending. Pending cases are opt-in model-backed benchmark tests; they are not counted as passed. |
| Real CUDA integration tests | Passed for CUDA matmul, array reduction, existing `.cu` and `.cuh` profiling, and event flushing before `cudaDeviceReset`. |
| C++ bottleneck-profile regression | Passed separately with a configured local Ollama model and the live C++ benchmark flow. |
| Direct `xxxxx.cu` production-command reproduction | The program compiled and exited successfully, but the finalizer recorded zero kernel launches in all five measured runs. It therefore has zero samples for both detected kernels. This is not a CUDA profile pass. |

## Existing CUDA profile reproduction

The supplied `xxxxx.cu` has two launch expressions inside `sumOfSquaresGPU`, but the original `main()` calls only CPU `sumOfSquares`. The test ran the **KernelPilot: Profile Bottlenecks** command on that exact file, compiled its temporary instrumented copy, and executed the original program with one warmup and five measured program runs. The measured runs printed the CPU checksum; the profiler's finalization protocol confirmed zero kernel invocations. The user's source file was not modified.

The output now distinguishes zero executed launches from event registration/finalization errors and parser mismatches. To get kernel samples for this source, its actual program flow or an explicitly supplied caller must invoke the existing `sumOfSquaresGPU` implementation with the intended data. KernelPilot does not guess or insert that call.

## Not verified

- No live Meta endpoint request was made as part of this verification.
- No general CUDA result-correctness claim is made for direct existing-source profiling; its report says “Result correctness not independently verified” absent an external oracle.
- Compute Sanitizer, Nsight analysis, a clean-profile VSIX installation, and Marketplace publication were not performed.
- Seven opt-in model-backed benchmark cases were pending in the full suite. A separate C++ live-model integration passed, but that does not change the pending count for the default full-suite run.
