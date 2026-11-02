# CUDA and NVIDIA GPU setup

This guide covers the machine requirements for CUDA compilation and runtime checks. It does not imply that compilation alone verifies the result.

1. Install a CUDA Toolkit and compatible NVIDIA driver for the target device.
2. In the same environment that launches VS Code, check `nvcc --version` and `nvidia-smi`.
3. In VS Code run **KernelPilot: Check NVIDIA Diagnostics Environment**. Review tool versions, GPU/driver visibility, and the limited metric-discovery capability probe. That probe does not launch your kernel and is not proof that hardware counter collection succeeds.
4. Confirm that the reported GPU supports the architecture configured in `kernelpilot.cudaArchitecture`. When empty, some workflows detect the visible GPU architecture; otherwise `nvcc` may use its default.
5. Configure project include paths, defines, language standard, and other build settings. Direct source profiling can read a matching `compile_commands.json` entry or `.vscode/c_cpp_properties.json`; complex projects may need an explicit caller translation unit.
6. Run CUDA work only after reviewing the source and consent prompt. Compiler execution has limits but is not OS-sandboxed. Candidate runtime requires supported Linux Bubblewrap filesystem/process isolation.
7. Review device/compiler versions, correctness status, timer boundaries, sample counts, and isolation status in the result.

GPU devices are shared system resources. A kernel can hang or exhaust device memory; the extension does not guarantee recovery or containment. See [Profiling](docs/profiling.md), [Benchmarking](docs/benchmarking.md), and [Troubleshooting](docs/troubleshooting.md).

In the last recorded actual Nsight Compute attempt on the NVIDIA RTX A2000 Laptop GPU, `ncu` returned `ERR_NVGPUCTRPERM`. Actual hardware-counter collection and successful `.ncu-rep` export remain unverified in that environment. Do not change driver settings or counter permissions to work around this from KernelPilot; consult the system administrator if profiling access is needed. Test fixtures and fake CLI/parser tests verify behavior around available/error outputs only.

If a run fails, preserve non-sensitive compiler/runtime diagnostics and report whether the failure happened during compiler setup, compilation, runtime initialization, kernel execution, finalization, correctness validation, or metric parsing. Redact API credentials, private source, and sensitive paths before sharing logs.
