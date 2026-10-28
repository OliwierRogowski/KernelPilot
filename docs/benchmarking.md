# Benchmarking and interpreting results

KernelPilot contains more than one benchmark path. Always read the report's backend, workload sizes, correctness state, sample count, and timer definitions before comparing numbers.

## Correctness evidence

The structured CUDA comparison path expects runtime device confirmation and per-size correctness records. Its validation code rejects malformed or missing records, duplicate cases, incomplete metric sets, and failed correctness rows. The experiment workflow uses a user-provided harness to compare original and candidate implementations. The extension checks protocol structure and paired cases; it cannot prove that the harness's oracle is independent or that the harness measures only the intended algorithm.

Direct profiling of an existing `.cu` or `.cuh` program is different: it records runtime executions and event durations but does not automatically compare the output against a CPU oracle. Unless an independent test or reference is also run, its report says **“Result correctness not independently verified.”** A zero sample result is not a successful GPU profile.

## Timer scopes

The benchmark adapters distinguish these phases when implemented by the selected harness:

| Metric | Scope |
|---|---|
| CPU `compute` | The selected CPU algorithm call, excluding its surrounding setup and result check in the validated adapter. |
| CPU `end_to_end` | The CPU work included by that adapter's documented end-to-end boundary. It is not automatically the complete application runtime. |
| CUDA `h2d` | Host-to-device transfers timed by the harness. |
| CUDA `kernel` | Kernel execution measured with CUDA events and the harness's synchronization rules. |
| CUDA `d2h` | Device-to-host transfers timed by the harness. |
| CUDA `end_to_end` | The operation range explicitly measured by the harness, which may include transfers and launch/setup overhead. Inspect the harness/report to confirm its exact boundary. |
| Existing-source kernel events | CUDA events immediately before and after each original launch on its launch stream. The events are synchronized during finalization, not after each launch. These are per-invocation kernel timings, not whole-program time. |
| Existing-source async copies | CUDA events around existing `cudaMemcpyAsync` calls on their original streams. Synchronous copies, allocations, and host preparation are not separately measured by this profiler. |

Not every path provides every metric. Missing metrics must remain unavailable; a kernel timer is not interchangeable with total GPU operation time. Per-operation durations across streams can overlap and must not be added as if they were sequential.

## Comparison rules

- Compare CPU compute with a matching CUDA kernel scope only when the algorithm, input values, sizes, and output work are equivalent.
- Compare end-to-end with end-to-end only when both boundaries represent equivalent work. Do not compare a CPU whole-operation time with a GPU kernel-only time.
- Pair samples by both workload size and sample ID. Extra unmatched samples are reported, not silently paired by array order.
- Review medians, ranges, sample counts, and the paired sign-test interpretation together. A lower median alone is descriptive; it does not establish a stable advantage.
- Conclusions apply to the measured device, toolchain, inputs, and timers. A handful of sizes does not define a general CPU/GPU crossover threshold.
- Time alone cannot establish memory-bandwidth saturation, occupancy limits, coalescing efficiency, or compute saturation. Those diagnoses require the relevant hardware/profiler evidence.
- No CPU comparison or speedup is reported if there is no CPU implementation or comparable timing scope.

## Samples, warmup, and reports

Benchmark sample counts are defined by the selected harness and validated protocol. The direct existing-CUDA source profiler runs the configured number of full-program warmups and measured repetitions in separate isolated processes; warmup events are excluded from the measured data. Program side effects repeat. The default direct-profile settings are one warmup and five measured runs.

The source profiler saves raw events and build/runtime metadata under `.kernelpilot/profiles/`. Experiment snapshots and reports use `.kernelpilot/experiments/`. These are workspace artifacts and are ignored by the repository's Git configuration. Avoid sharing them without checking for proprietary source paths or application output.

See [Profiling](profiling.md) for the existing-source timer and execution boundaries. The [experiment workflow](getting-started.md#first-cuda-experiment) uses a separate user-owned harness.
