# Benchmarking and interpreting results

KernelPilot contains more than one benchmark path. Always read the report's backend, workload sizes, correctness state, sample count, and timer definitions before comparing numbers.

## Correctness evidence

The structured CUDA comparison path expects runtime device confirmation and per-size correctness records. Its validation code rejects malformed or missing records, duplicate cases, incomplete metric sets, and failed correctness rows. The experiment workflow uses a user-provided harness to compare original and candidate implementations. The extension checks protocol structure and paired cases; it cannot prove that the harness's oracle is independent or that the harness measures only the intended algorithm.

Direct profiling of an existing `.cu` or `.cuh` program is different: it records runtime executions and event durations but does not automatically compare the output against a CPU oracle. Unless an independent test or reference is also run, its report says **“Result correctness not independently verified.”** A zero sample result is not a successful GPU profile.

## CUDA result correctness validation

Use **KernelPilot: Validate CUDA Results Against Reference** to compare a reference executable and a CUDA candidate outside any benchmark timer. This is an explicit, separate run. The command generates one deterministic `float64` vector, saves its seed and input artifact, and passes the same `--kernelpilot-input <path>` file to both programs. It does not infer that arbitrary `.cu` programs produce comparable outputs: each executable must implement the [versioned input/output contract and example](../rogowskikernelpilot/examples/cuda-result-validation/README.md).

The output protocol declares one result type (`int32`, `uint32`, `int64`, `uint64`, `float32` or `float64`), a count, then indexed values. Integer comparisons are exact. Floating-point equality uses `abs(candidate-reference) <= absoluteTolerance + relativeTolerance * abs(reference)`. Two NaNs compare equal; infinities compare equal only with the same sign. A different result type, different output length, missing/malformed records, process failure, timeout and cancellation are all reported explicitly. A reference execution error produces `tool-error`, never a failed candidate result. Reports contain mismatch counts, initial differing indices and maximum computable absolute/relative errors.

`failed` is an invalid candidate result and the report attaches an `optimizationGate` that marks the optimization incorrect and disallows a speedup recommendation. `passed` establishes correctness for this input only; it does not establish a speedup. Sanitizer outcomes, CUDA event timings and correctness results remain separate report fields. The command can attach its results to an existing KernelPilot CUDA JSON report. Programs run sequentially with direct argument arrays, a per-process timeout, cancellation support and the project's filesystem/process isolation.

Example failure report excerpt (illustrative):

```json
{
  "status": "failed",
  "seed": 1234,
  "inputCount": 64,
  "comparison": {
    "status": "failed",
    "mismatchCount": 64,
    "comparedCount": 64,
    "incompatibleOutputCount": 0,
    "firstMismatches": [
      { "index": 0, "reference": "1.25", "candidate": "1.5", "absoluteError": "0.25", "relativeError": 0.2, "reason": "absolute error 0.25 exceeds allowed 0.0000135" }
    ],
    "maxAbsoluteError": "0.25",
    "maxRelativeError": 0.2
  },
  "optimizationAssessment": {
    "disposition": "incorrect",
    "recommendAsSpeedup": false,
    "reason": "Candidate output differs from the reference or has incompatible output shape/type."
  }
}
```

## Comparing baseline and candidate reports

Run **KernelPilot: Compare Optimization Reports**, then select the baseline JSON and candidate JSON. The comparison opens in a VS Code webview and can be exported as JSON or Markdown. It reads both reports and never modifies either source file. Set `kernelpilot.reportComparisonPracticalChangePercent` to choose the minimum practical change (default 3%).

The comparison recognizes KernelPilot phase reports (`rawPhaseSamples`), existing-source CUDA profile reports (`rawSamples`), and legacy profile summaries. It displays the median, sample count, min–max spread, baseline/candidate speedup and percentage time change for each matching timing scope. It also shows correctness separately from performance, sanitizer outcomes, and NCU metrics. NCU rows are compared only when kernel name, launch ID, metric name, and explicitly recorded unit match uniquely. Missing counters stay unavailable.

When at least five valid raw samples exist on each side, KernelPilot uses a deterministic, independent percentile bootstrap of the median speedup with a 95% interval (5,000 resamples). An improvement requires the interval to be entirely above `1 + threshold`; a regression requires it to be entirely below `1 - threshold`. Otherwise the result is inconclusive. This method treats the runs as independent; it assumes representative samples and cannot remove thermal drift, run-order effects, or hidden workload differences. Identical sample numbers in separate reports are not treated as matched pairs. Fewer than five samples and summary-only legacy reports do not support a directional conclusion. Zero, negative, non-finite, or mixed-invalid timing groups are reported as invalid data.

GPU model, input hash and size, run parameters, timing scope, compiler/build options, and environment are checked when available. Missing fields are shown as uncertainty; known differences in GPU, input, parameters, timing method, or matching timing scopes make the reports incomparable. Compiler and environment differences are called out as caveats. Older reports remain readable: available summaries are shown descriptively, while absent metadata and raw samples cannot establish comparability or statistical confidence.

The candidate correctness status is independent of the performance result. A failed/incorrect candidate is never recommended even when measured faster. Missing validation or `tool-error` does not count as passing correctness. The comparison report records the evidence behind every conclusion.

Example webview result (illustrative):

```text
Result: improvement · comparability: comparable
Correctness: baseline passed, candidate passed
kernel · 256: baseline median 10.0 ms (n=7), candidate 8.0 ms (n=7)
Speedup 1.250× · time change -20.0% · 95% bootstrap interval [1.21, 1.29]×
Recommendation: recommend (candidate correctness passed; interval cleared 3% threshold)
```

Those values illustrate the display only; they are not a KernelPilot GPU measurement.

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
