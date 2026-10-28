# KernelPilot architecture and experiment pipeline

KernelPilot is a VS Code extension (TypeScript/Node.js) with a small native Clang analyzer (C++17). It has no backend service or database. Commands, output channels, chat, and benchmark reports live in the existing extension.

## Existing CUDA experiment flow

```text
VS Code .cu buffer/file
  → lexical CUDA analysis + actual nvcc / nvidia-smi availability probes
  → immutable experiment snapshot + SHA-256 under .kernelpilot/experiments/<id>
  → configured provider returns schema-validated full candidate + rationale
  → candidate.cu saved separately + VS Code source diff
  → explicit user consent before nvcc compilation
  → original and candidate compiled against the same user-owned harness
  → explicit consent before running test executables
  → harness correctness records and paired GPU timings parsed and compared
  → experiment.json + exportable Markdown report
```

`src/cudaExperiment.ts` handles lexical kernel/signature inspection, proposal validation, immutable source capture, experiment schema, and report generation. `src/modelProvider.ts` transports a common chat request through Ollama or the limited OpenAI-compatible adapter; `src/aiConfig.ts` resolves `.env`, environment, and legacy VS Code settings consistently. `src/cudaValidation.ts` validates the harness result protocol and acceptance gate. `src/candidateRunner.ts` executes harness binaries with a reduced environment, limits, and tested Bubblewrap isolation where available. `src/extension.ts` integrates the workflow into the existing Command Palette, progress notifications, Output channels, editor diff, and file dialogs.

The existing benchmark command and `.cu` validation share an in-process lock so two KernelPilot benchmark commands do not run concurrently on the same GPU. This cannot prevent unrelated applications or separate VS Code extension hosts from using the device.

## Trust and evidence boundaries

- Static analysis is lexical and heuristic. It cannot know occupancy, registers, spills, hardware coalescing efficiency, or runtime bottlenecks.
- Candidate JSON schema and unchanged `__global__` signatures are checked. This does not establish equivalent semantics.
- The harness must be written and reviewed independently. It is responsible for a CPU/reference oracle, numerical tolerance, deterministic edge and size cases, CUDA error checks, warmup, synchronization, repeated event timing, and emitted output. KernelPilot checks protocol structure and matching cases, but cannot prove the harness truthfully implements those requirements.
- GPU speedup is reported only from matching harness runs with all correctness rows passing; acceptance also requires median at least 1.02x and no test case more than 2% slower. This conservative prototype policy should be calibrated for the target hardware and benchmark noise.
- A compiler/object build is a compile status only. Missing harness, GPU, driver, model, or invalid records result in `cannot_confirm`/unverified states; no synthetic GPU data is generated.
- The model does not choose final acceptance. Compilation, harness correctness, and measurements control that decision.

## Security boundary

The extension never shell-interpolates compiler commands: it invokes fixed executable paths and argument arrays. `.env` is read into the extension process only; API secrets are excluded from candidate runtime environment. Source snapshots and candidate artifacts use restrictive file modes and are gitignored by default.

The nvcc/host compiler runs as the user's account with a sanitized environment, `prlimit` CPU/address-space/file/process limits, timeout, and a temporary working directory. Linux `RLIMIT_NPROC` is per real user, so the compiler limit is calculated from the visible host process/thread count plus 256 slots (at least 4096, bounded by the inherited hard limit); a fixed low limit can stop GCC from spawning `cc1plus`. The compiler is **not** filesystem- or network-sandboxed. Explicit VS Code confirmation precedes compiler invocation. The runtime preflight requires tested Bubblewrap filesystem/process namespace support; it attempts a network namespace separately. If network isolation is unavailable, the UI says so and asks again before execution. It refuses runtime when filesystem/process sandboxing is unavailable. GPU devices remain shared and GPU reset/hang/OOM containment is not guaranteed. Do not treat this as a complete security boundary.

The Clang native analyzer also reads user source in a normal subprocess. It has a reduced environment, timeout, and output cap, but no filesystem/network namespace or memory limit; analyzer parsing is therefore still within the current user's host security context.

## Provider configuration

Provider settings/environment are resolved once per request: process env (including `.env` values loaded from workspace root) overrides legacy `kernelpilot.*` settings. No provider URL, credentials, or model is inferred from Meta product names. See [META_API.md](META_API.md).
