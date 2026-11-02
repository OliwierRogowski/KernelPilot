# Profiling C++, `.cu`, and `.cuh`

Run **KernelPilot: Profile Bottlenecks** with the source open in the editor. The command accepts a selection or the whole file where the selected workflow supports it. CUDA files are recognized by both their extension and VS Code's `cuda-cpp` language ID.

## C and C++ path

The existing C/C++ profiling path uses source analysis and the benchmark/adapter flow; CUDA comparisons may involve generated support code. Its result depends on the discovered target, oracle, workload, and compiler checks. Read the report to see the selected function and timer boundaries. This path has distinct code from direct profiling of an existing CUDA translation unit; see [Benchmarking](benchmarking.md) for metric compatibility.

## Direct profiling of existing CUDA

The direct `.cu`/`.cuh` profile path does not ask the model to replace the algorithm. It copies the selected source into a temporary `profiled_original.cu`, wraps discovered existing launch expressions with CUDA event records, compiles that copy with `nvcc`, and runs the resulting executable in the candidate runner's isolated environment after confirmation. The original source file is not instrumented in place.

The profiler reuses a matching `compile_commands.json` entry when available, otherwise `.vscode/c_cpp_properties.json`, otherwise conservative defaults. It also uses `kernelpilot.cudaCompiler` and `kernelpilot.cudaArchitecture` when configured. Build-system options that are not represented in those inputs may still require a caller translation unit or complete compile configuration.

### Supported source shapes

- **Runnable CUDA translation unit:** A supported CUDA source file with `int main()` or `int main(int, char**)` containing or reaching original launch expressions is compiled and run as a copied translation unit. A `.cu` file is CUDA source, not a binary. If the program takes command-line arguments, the profiler asks for them.
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

Use [CUDA result correctness validation](benchmarking.md#cuda-result-correctness-validation) when a reference implementation is available. The event profiler does not automatically provide comparable program outputs; the validation command requires both executables to implement the explicit shared-input/result protocol.

## Nsight Compute and Compute Sanitizer

KernelPilot also provides **KernelPilot: Run Nsight Compute and Sanitizer** for an already built CUDA executable. It is optional and disabled until `kernelpilot.nvidiaDiagnosticsEnabled` is enabled. Enter the executable path, its arguments as a JSON string array (for example `["--size", "1024"]`), and a kernel name regular expression. Arguments are passed directly to the child process without a shell. The command writes `nvidia-<timestamp>.json` and `nvidia-<timestamp>.txt`; it creates a raw `.ncu-rep` file only when Nsight Compute successfully exports the report. A `.cu` suffix denotes CUDA source code, not an Nsight Compute report. When enabled, **Profile Bottlenecks** also runs these checks after its independent CUDA event timing and includes the structured diagnostic report and links in the existing profile JSON.

Use **KernelPilot: Check NVIDIA Diagnostics Environment** to inspect installed tool versions, GPU model/driver visibility, and whether the installed `ncu` accepts a metric-discovery query. The command saves JSON and text details and offers **Open details** and **Save report** actions. A successful metric query is only a capability/discovery signal: it does not prove that a kernel can be profiled or that an `.ncu-rep` can be exported. A permission error such as `ERR_NVGPUCTRPERM` is reported separately. This check never modifies driver or system permissions and does not launch an application kernel.

Nsight Compute metric names are queried from the installed `ncu` (`--query-metrics --query-metrics-mode all --csv`) and intersected with candidate SM throughput, DRAM throughput, occupancy, memory-sector efficiency, and warp-stall metrics. This avoids assuming that a particular GPU or Nsight Compute release supports a fixed set. Set `kernelpilot.ncuMetrics` to request particular metrics; unsupported names are listed as unavailable in JSON. `kernelpilot.ncuKernelRegex` and `kernelpilot.ncuLaunchCount` control selection. The CLI supports kernel-name filtering, launch-count limits, metric selection, report export and raw output pages; the output also includes tool text for diagnosis. CSV parsing preserves kernel name, launch ID, metric name, value, and unit. The tested parser handles both row-per-metric and raw-page wide CSV layouts; the saved examples are in `src/test/fixtures/`. The raw report remains the authoritative artifact when console output cannot be parsed across CLI versions.

Set `kernelpilot.computeSanitizerTools` to any of `memcheck`, `racecheck`, `initcheck`, and `synccheck`; an empty list runs none. Each tool gets a separate application execution and records its status, exit code, and stdout/stderr. `clean` requires exit code zero and an explicit zero-error or zero-hazard summary; empty or incomplete output is `tool-error`. `problem`, `not-run`, and `tool-error` are kept distinct. A nonzero target exit can indicate a sanitizer finding or an application failure; inspect the stored output. If compiling with NVCC, add `-lineinfo` in the project's own build configuration to improve source location attribution; KernelPilot does not alter project build flags automatically. Deliberately faulty examples for each tool are in [`examples/nvidia-sanitizer`](../rogowskikernelpilot/examples/nvidia-sanitizer/README.md).

CLI options and output modes follow NVIDIA's [Nsight Compute CLI guide](https://docs.nvidia.com/nsight-compute/NsightComputeCli/index.html); tool selection and checker scope follow the [Compute Sanitizer manual](https://docs.nvidia.com/compute-sanitizer/ComputeSanitizer/index.html). This environment's installed-tool checks were run with Nsight Compute 2026.3.1.0 and Compute Sanitizer 2026.3.0.0. Parser and error-path tests also use controlled fake CLIs. Those tests do not declare compatibility with other tool releases; the environment check uses advertised `--help` capabilities where available and preserves unfamiliar output as an unknown/error result.

**Actual counter verification limitation:** the recorded Nsight Compute profile attempt on the NVIDIA RTX A2000 Laptop GPU returned `ERR_NVGPUCTRPERM`. Therefore real metric collection and successful `.ncu-rep` export have not been verified in that environment. The synthetic CLI tests, saved CSV parser fixtures, and a metric list returned by `--query-metrics` are not actual kernel profiling. A `.ncu-rep` is produced only if a real Nsight Compute export completes successfully. KernelPilot does not modify system counter permissions or driver configuration.

The report records the GPU name when `nvidia-smi` is available and tool version output when the tools run. It labels observed counters separately from hypotheses; a lone counter or execution time is not treated as definitive bottleneck evidence. Benchmark timings from CUDA events and CPU/GPU harnesses are separate executions and are not replaced by profiler/replay timings. Missing counters, missing devices, tool failures, and tool output are retained explicitly. Nsight Compute may require hardware-counter access configured by the system administrator; KernelPilot never changes permissions or driver configuration. Use compatible NVIDIA Nsight Compute, CUDA toolkit/Compute Sanitizer, driver, and GPU versions per NVIDIA's compatibility guidance.

Example report excerpt (values are illustrative):

```json
{
  "gpu": "GPU name when detected",
  "profile": { "status": "completed", "metrics": [{ "kernel": "vectorAdd", "launchId": "0", "name": "sm__throughput.avg.pct_of_peak_sustained_elapsed", "value": "...", "unit": "%" }], "unavailableMetrics": [] },
  "sanitizers": [{ "tool": "memcheck", "status": "clean", "exitCode": 0 }],
  "observations": ["launch 0 kernel vectorAdd: sm__throughput...=<measured value> %"],
  "hypotheses": []
}
```
