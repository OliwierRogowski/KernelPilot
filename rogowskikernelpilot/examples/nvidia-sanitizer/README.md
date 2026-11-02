# Compute Sanitizer fixtures

These four programs each contain one intentional CUDA defect, selected for the detector's scope:

| File | Intended detector | Defect |
|---|---|---|
| `memcheck_oob.cu` | `memcheck` | Out-of-bounds global-memory write. |
| `racecheck_shared_hazard.cu` | `racecheck` | Shared-memory write/read hazard across warps without ordering. |
| `initcheck_uninitialized.cu` | `initcheck` | Read from an allocated but uninitialized global-memory location. |
| `synccheck_divergent_barrier.cu` | `synccheck` | A thread executes `__syncwarp(mask)` without being a participant in the supplied mask. |

Build from this directory with line tables so supported reports can include file/line locations:

```sh
nvcc -lineinfo memcheck_oob.cu -o memcheck_oob
compute-sanitizer --tool memcheck --error-exitcode 86 ./memcheck_oob
nvcc -lineinfo racecheck_shared_hazard.cu -o racecheck_shared_hazard
compute-sanitizer --tool racecheck --error-exitcode 86 ./racecheck_shared_hazard
nvcc -lineinfo initcheck_uninitialized.cu -o initcheck_uninitialized
compute-sanitizer --tool initcheck --error-exitcode 86 ./initcheck_uninitialized
nvcc -lineinfo synccheck_divergent_barrier.cu -o synccheck_divergent_barrier
compute-sanitizer --tool synccheck --error-exitcode 86 ./synccheck_divergent_barrier
```

Each invocation is a separate process with a nonzero error exit code and should be run with a timeout when used in automated checks. To exercise KernelPilot's status mapping, first enable `kernelpilot.nvidiaDiagnosticsEnabled`, select only the matching tool in `kernelpilot.computeSanitizerTools`, set the executable to the built fixture, and use its kernel name as the filter. The diagnostic command records `clean`, `problem`, `not-run`, or `tool-error`; inspect tool output because an application failure can also produce a nonzero exit. `-lineinfo` is supplied by this example build; KernelPilot does not alter project compiler flags automatically.

These fixtures are designed for sanitizer checks, not performance measurement. Run them only when you understand the intentional invalid access, uninitialized read, race, or synchronization error. See [NVIDIA diagnostics and known limits](../../../docs/profiling.md#nsight-compute-and-compute-sanitizer). The project's previous real `ncu` profile attempt returned `ERR_NVGPUCTRPERM`; sanitizer parser tests and fake Nsight CLI outputs do not demonstrate that hardware counters or `.ncu-rep` export work on a GPU.
