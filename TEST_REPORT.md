# KernelPilot verification report

Verification was run on the current `github-export` working tree on 2026-11-02. Test fakes, saved report fixtures, and actual GPU executions are identified separately below.

## Environment

- VS Code extension test host: 1.144.0.
- GPU: NVIDIA RTX A2000 Laptop GPU, compute capability 8.6; driver 615.71.09.
- CUDA compiler: NVCC 13.4.92.
- Nsight Compute: 2026.3.1.0.
- Compute Sanitizer: 2026.3.0.0.

## Project checks

| Check | Result |
|---|---|
| `npm run check-types` | Passed. |
| `npm run lint` | Passed. |
| `npm run compile` | Passed. |
| `npm run compile-tests` | Passed. |
| Full `npm test` | 132 passed, 8 pending; exit code 0. The pending tests are opt-in/model-dependent benchmark cases. |
| Markdown local links | Passed for 22 project Markdown files, including the untracked example guides before commit. |
| README command labels | All 17 manifest command labels are present in the root README. |
| `git diff --check` | Passed. |

## CUDA and diagnostics evidence

| Scenario | Evidence type | Result |
|---|---|---|
| CUDA compilation/execution and source profiling paths | Actual GPU runs | CUDA reduction, matrix multiplication, direct `.cu`/`.cuh` profiling, and result-validation examples ran on the RTX A2000. Tests verified exact/reported correctness and timer-specific data paths. |
| Saved report comparison | Actual GPU run | The current full suite measured 7 samples per implementation with CUDA events. This run recorded baseline median 0.003242667 ms, candidate median 0.003048 ms, speedup 1.0639x, and a bootstrap interval [1.0538, 1.1621], producing `improvement`. Earlier repeat runs varied, including an inconclusive result; these tiny microbenchmarks are noisy and do not establish general performance. |
| Four intentionally faulty Compute Sanitizer fixtures | Actual GPU runs, each bounded by a 30-second timeout | `memcheck`, `racecheck`, `initcheck`, and `synccheck` all exited with configured diagnostic code 86 and reported their intended defect. Racecheck reported one hazard; the other tools reported 4, 1, and 17 errors respectively. |
| Clean sanitizer controls from prior verification | Actual GPU runs | All four tools completed on the valid control program without reported defects. |
| NVIDIA environment probe, fake executable arguments, timeout/cancel, partial reports and status mapping | Test doubles in the extension suite | Passed. These verify orchestration and error handling, not hardware-counter collection. |
| NCU saved CSV formats and incomplete/unsupported CLI output | Saved parser fixtures and controlled fake CLIs | Parser and failure-path tests passed. These are not actual Nsight kernel profiles. |
| Nsight Compute counter collection | Actual tool attempt previously recorded | `ncu` returned `ERR_NVGPUCTRPERM` on this GPU. Real counter collection and successful `.ncu-rep` export remain unverified. No system or driver permissions were changed. |

The ordinary benchmark regression that checks diagnostic tools are not invoked is currently pending with the other opt-in benchmark tests; the production path and focused integration coverage are present, but this specific real-command marker scenario was not executed in this full run. Do not treat it as a pass.

## Scope limits

- GPU timing evidence is specific to this host and workload. A small microbenchmark can be affected by clock state, thermal behavior, and run ordering.
- Nsight Compute's visible metric list or a successful capability query is not proof that a kernel profile or report export will work.
- The extension cannot independently prove that a user-authored CUDA benchmark harness is a sound reference or timer.
- Optional provider-backed tests were not run by default; no live external provider result is claimed here.
