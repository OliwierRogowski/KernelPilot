# Profiling C++, `.cu`, and `.cuh`

Run **KernelPilot: Profile Bottlenecks** with the source open in the editor. The command accepts a selection or the whole file where the selected workflow supports it. CUDA files are recognized by both their extension and VS Code's `cuda-cpp` language ID.

## C and C++ path

The existing C/C++ profiling path uses source analysis and the benchmark/adapter flow; CUDA comparisons may involve generated support code. Its result depends on the discovered target, oracle, workload, and compiler checks. Read the report to see the selected function and timer boundaries. This path has distinct code from direct profiling of an existing CUDA translation unit; see [Benchmarking](benchmarking.md) for metric compatibility.

## Direct profiling of existing CUDA

The direct `.cu`/`.cuh` profile path does not ask the model to replace the algorithm. It copies the selected source into a temporary `profiled_original.cu`, wraps discovered existing launch expressions with CUDA event records, compiles that copy with `nvcc`, and runs the resulting executable in the candidate runner's isolated environment after confirmation. The original source file is not instrumented in place.

The profiler reuses a matching `compile_commands.json` entry when available, otherwise `.vscode/c_cpp_properties.json`, otherwise conservative defaults. It also uses `kernelpilot.cudaCompiler` and `kernelpilot.cudaArchitecture` when configured. Build-system options that are not represented in those inputs may still require a caller translation unit or complete compile configuration.

### Supported source shapes

- **Runnable `.cu` program:** A supported `int main()` or `int main(int, char**)` containing or reaching original launch expressions is compiled and run as a copied translation unit. If the program takes command-line arguments, the profiler asks for them.
- **Host wrapper that launches kernels:** The wrapper can be instrumented, but only invocations reached by the program's original `main` produce samples. A launch expression inside a function that `main` never calls is not an executed kernel.
- **Standalone kernel declaration:** A kernel declaration has no data or launch configuration by itself. The profiler needs an existing caller with actual grid/block/arguments. It does not invent those values.
- **`.cuh` header or `.cu` without a runnable `main`:** The profiler searches for a unique project `.cu` caller. If it cannot select one, set `kernelpilot.cudaProfileTranslationUnit` to a workspace-relative caller. The caller must invoke the selected function/kernel in its normal control flow.
- **Selected function/kernel:** Existing launch sites are filtered to the selection, while the original program supplies the call path, data, and parameters. If these are not recoverable from the project, provide a caller rather than relying on guessed parameters.

### What is timed

CUDA event pairs are recorded on each original kernel's stream. No per-launch synchronization is inserted, and event synchronization occurs at finalization so normal overlap between operations is retained during execution. Each event sample carries a measured-run ID, static launch-site ID, invocation number, grid/block configuration, shared-memory size, stream, and duration.

When the whole file is profiled, existing `cudaMemcpyAsync` calls are event-timed on their original stream and identified separately. Existing synchronous copies, allocations, host-side data preparation, and total application duration are not independently measured by this path. Multiple stream timings may overlap and are not summed. Instrumentation can affect very short operations.

When a source calls `cudaDeviceReset`, pending recorded events are finalized before the reset call. A normal return from the original `main` also finalizes pending events. If the program bypasses that path (for example, calls `std::exit` or aborts), the missing finalization marker is reported instead of treating absent records as a completed profile.

### Correctness and known limitation

Successful process execution confirms only that the program returned successfully. The direct source profile does not create an independent CPU oracle, so absent a separate test the report states **“Result correctness not independently verified.”**

Static launch detection is not runtime call-graph proof. For example, in a source where `main()` calls only a CPU function while an unused `sumOfSquaresGPU()` helper contains two kernel launches, the compiler can build and run the program and print checksums while the GPU kernels execute zero times. KernelPilot now uses a finalization record to distinguish that case and reports **“No original CUDA kernel launch executed”** with the detected sites. It reports zero samples; it does not inject a speculative call into the user's program.

Other unsupported or ambiguous patterns include macro-generated launches, unusual `main` signatures, indirect/function-pointer launch dispatch, hidden external launch callers, and unsupported build-system/device-link settings. Use an explicit caller translation unit when it invokes the original implementation and preserves the intended program semantics. Do not edit the original file merely to make the profiler report a timing.

See [Troubleshooting](troubleshooting.md#existing-cuda-profile-has-no-samples) for the no-sample diagnosis and [Configuration](configuration.md) for compiler and caller settings.
