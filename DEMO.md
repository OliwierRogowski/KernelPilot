# KernelPilot demo walkthrough

This walkthrough demonstrates the existing CUDA experiment workflow. It requires a model endpoint for proposal generation and a usable NVIDIA GPU/driver for runtime correctness and performance checks. Without those services it can demonstrate analysis and proposal-unavailable states only.

## Before the session

- Open the repository in VS Code and run the extension from source; see [Getting started](docs/getting-started.md).
- Configure Ollama or an OpenAI-compatible provider. Confirm the connection with **KernelPilot: Test configured model connection**.
- For live CUDA measurements, verify `nvcc --version` and `nvidia-smi` in the VS Code environment and confirm Bubblewrap runtime isolation is available.
- Configure `kernelpilot.cudaValidationHarness` with `rogowskikernelpilot/examples/vector_add_harness.cu` when the repository root is the workspace, or `examples/vector_add_harness.cu` when the extension directory is the workspace.

## Walkthrough

1. Open `rogowskikernelpilot/examples/vector_add_kernel.cu`.
2. Run **KernelPilot: Analyze and propose optimization for existing .cu**. Review its lexical evidence and limitations, saved original snapshot, separate candidate, manifest, and source diff.
3. Explain that the proposal is not accepted by model confidence or compilation alone.
4. Run **KernelPilot: Compile, validate, and benchmark CUDA experiment** and select the experiment's `original.cu`. Review the consent prompts before compilation and execution.
5. Review per-case correctness, device/compiler status, sample counts, median/p95 measurements, and the exact harness scope. A missing runtime or correctness result is not a pass.
6. Run **KernelPilot: Export CUDA experiment report** to save a Markdown report.

The included example harness checks deterministic cases and emits structured correctness/timing rows. Its test coverage includes source and GPU integration tests; whether a live demo succeeds still depends on the machine's current driver, isolation, build flags, and user configuration.

## No GPU or model available

Demonstrate the static source analysis or show the checked-in example. State that proposal generation is unavailable without a provider and that correctness/performance are unverified without a working GPU. Never present CPU time as GPU time or compilation as proof of correctness.
