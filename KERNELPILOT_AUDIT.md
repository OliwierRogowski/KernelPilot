# KernelPilot repository audit

This audit accompanies the current feature and documentation update. See [TEST_REPORT.md](TEST_REPORT.md) for dated checks and evidence categories.

## Repository and release state

- GitHub repository: [OliwierRogowski/KernelPilot](https://github.com/OliwierRogowski/KernelPilot).
- Work branch: `github-export`, tracking `origin/github-export`. At the start of this work it matched the remote tip (`00a11b2`); publication status is reported by the resulting commit/push, not assumed here.
- `main` remains the repository default branch. No release tag, Marketplace listing, or VSIX release is claimed.
- No license file is present; no reuse license is implied.

## Product boundaries checked

- The native C/C++ analyzer is Clang-backed and static; its findings are not runtime GPU measurements.
- AI transport supports Ollama and a limited OpenAI-compatible chat-completions interface.
- CUDA proposals preserve the original source and remain candidates until an independent correctness check and comparable benchmark support them.
- Reference-result validation requires the documented shared-input/output protocol; it does not infer comparable values from arbitrary `.cu` files.
- Ordinary benchmarks, explicit reference validation, direct CUDA-event profiling, Nsight Compute, and Compute Sanitizer are separate executions and report fields.
- Report comparison checks provenance and available samples; missing metadata is uncertainty. A failed candidate cannot be recommended.
- Runtime candidate isolation depends on Linux Bubblewrap support. Compilation is consent-gated and resource-limited but not filesystem/network sandboxed; GPU reset, hang, and memory exhaustion are not guaranteed to be contained.

## NVIDIA verification boundary

The installed GPU and NVIDIA CLI versions are recorded in [TEST_REPORT.md](TEST_REPORT.md). Compute Sanitizer detected the intended issues in all four faulty example programs during timeout-bounded actual runs. Nsight Compute returned `ERR_NVGPUCTRPERM` during the recorded actual profile attempt. Actual counter collection and successful `.ncu-rep` export remain unverified. No driver setting or system permission was changed. Fake CLI tests and saved CSV parser fixtures are not actual profiling.

## Publication and local files

The root `.env`, generated `.kernelpilot` reports, dependency trees, test downloads, and native build output are local artifacts and should not be published. The `.gitignore` rules exclude these paths. The README/example changes and source tests are project files; generated extension `dist/` output is tracked in this repository and is rebuilt by the project compile command.
