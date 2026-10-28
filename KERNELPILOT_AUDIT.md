# KernelPilot readiness audit

## Repository baseline

- The repository's `origin` remote points to `OliwierRogowski/KernelPilot`.
- During this audit, the remote was reachable and reported as public with `main` as the default branch.
- There are no Git tags. The observed `origin/main` and local `github-export` baseline is `0cf7db9` (`Prepare KernelPilot hackathon export`). This commit is the practical comparison point, not a tagged release.
- The current worktree contains uncommitted product, test, build, and documentation changes. No release tag is created by this preparation.
- The repository has no license file. No license has been added; the maintainer must choose one before making a licensing claim.

## Verified product boundaries

- The native analyzer provides Clang-backed C/C++ source analysis; findings are static and heuristic.
- Model transport supports Ollama and a limited OpenAI-compatible chat-completions subset. Live account/provider availability must be tested by the user.
- CUDA conversion and optimization proposals are candidates, not correctness claims. The `.cu` experiment workflow relies on a separate user-authored validation harness.
- Structured benchmark paths validate device/correctness/timing records and compare matching timer scopes and sample IDs. A harness's claimed oracle is not independently proved by the extension.
- Direct CUDA source profiling measures only runtime events around reached original launches and supported asynchronous copies. It reports correctness as not independently verified when no separate oracle is run.
- Candidate runtime isolation depends on supported Linux Bubblewrap namespaces. Compiler execution is resource-limited and consent-gated but not OS-sandboxed.
- There is no published Marketplace listing or VSIX release. `npm run package` creates a production bundle, not a VSIX.

## Confirmed direct CUDA diagnostic

The supplied `cuda-interface-engine/src/cpu/xxxxx.cu` was compiled and run through the production **KernelPilot: Profile Bottlenecks** command in the extension-host integration test. Its `main()` fills a vector and calls only the CPU `sumOfSquares` in a 20-iteration loop. It does not call the existing `sumOfSquaresGPU` function. The two detected launch expressions are inside that unused GPU helper. The instrumented finalizer correctly records zero runtime launches for all measured runs; the profiler must therefore report zero samples rather than claim a CUDA profile.

This is a source call-path limitation, not a failed CUDA event measurement. The direct profiler cannot infer or inject the user's intended data, wrapper invocation, or control flow. See [Profiling](docs/profiling.md).

## Security and publication checks

- `.env` is ignored and is not tracked at the selected baseline. The repository template must contain placeholders only.
- The baseline secret scan found no high-confidence provider token, private-key, or long secret assignment in tracked project files or scanned history. Dependency trees were excluded from this source scan and are being removed from the current Git index as vendored local dependencies.
- The repository's top-level `node_modules` trees are unnecessary for source distribution and should be ignored/untracked without deleting local files.
- Profile/experiment directories, VS Code test downloads, output, and native analyzer build output are local artifacts and are excluded by Git ignore rules.
- No GitHub CLI or authenticated GitHub connector was available during preparation. Read-only API access confirmed the existing destination; push permission and branch protection could not be verified. No push or PR is claimed.

## Current verification

See [TEST_REPORT.md](TEST_REPORT.md) for the exact commands, environment, passed/pending counts, GPU evidence, and the direct-profile zero-launch result. See [CHANGELOG.md](CHANGELOG.md) for changes relative to the baseline.

## Remaining release decisions

1. Revoke and replace any provider credential that was exposed outside its private `.env` file.
2. Select a repository license before adding a license file or claiming a reuse license.
3. Confirm GitHub write access and the appropriate branch/PR procedure before publishing the prepared branch.
4. Decide whether the untracked optional fine-tuning data/report are part of this publication; their provenance and license suitability are not independently verified.
