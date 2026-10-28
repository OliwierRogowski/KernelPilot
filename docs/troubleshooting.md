# Troubleshooting

## AI provider errors

- Check `KERNELPILOT_AI_PROVIDER`, the base URL, model identifier, and provider account access. The selected provider must actually expose the protocol KernelPilot uses.
- `401`/`403` means the provider rejected the configured credential. `429` indicates a provider rate limit. A timeout or connection error means no response was received; KernelPilot does not fabricate one.
- OpenAI-compatible endpoints must use HTTPS unless they are on localhost. Do not place credentials in the endpoint URL.
- If the provider reports `finish_reason=length`, KernelPilot can retry a truncated response with a bounded larger output budget. If retries are exhausted, inspect the reported finish reason and reduce the requested artifact size or choose a model/context with sufficient output capacity.
- Run **KernelPilot: Test configured model connection**. This checks a live request, not the quality of generated code.

## `nvcc` or compilation failures

- Confirm `nvcc --version` works in the environment that launches VS Code and that `kernelpilot.cudaCompiler` points to the intended compiler.
- Use a matching `compile_commands.json` entry or configure `.vscode/c_cpp_properties.json` include paths, defines, and C++ standard. Build-system generated headers, library link flags, and separate device-link stages may need a project caller or full compile command.
- Read the complete compiler diagnostics in KernelPilot output. A successful object compile does not prove that the executable ran or that the result is correct.
- The compiler and host compiler are not OS-sandboxed. Review the source and consent prompt before compiling.

## GPU or driver unavailable

- Check `nvidia-smi`, CUDA Toolkit installation, driver compatibility, container device passthrough, and that the GPU is visible to the VS Code process.
- CUDA compile-only checks may work without a usable GPU, but runtime correctness and timing cannot. KernelPilot reports missing runtime evidence rather than substituting CPU data.
- Candidate runtime requires supported Linux Bubblewrap filesystem/process namespaces. If the preflight fails, runtime execution is refused; do not disable isolation to get a result.
- A candidate can still hang or exhaust resources on the shared GPU. Runtime isolation does not make arbitrary GPU kernels safe.

## Existing CUDA profile has no samples

The command may find launch syntax in source that never executes. Inspect the profiler output's detected launch sites and its finalization record:

- **Finalizer recorded zero launches:** The original program ran, but none of the instrumented launch expressions were reached. Check whether `main()` calls the host wrapper that owns the launches. A declared kernel or unused wrapper is not a runtime invocation. Provide a real caller/translation unit or make the intended program call the original wrapper; KernelPilot does not guess the data, arguments, or grid/block values.
- **Finalization marker missing:** The original control flow may bypass normal `main` return (for example, `std::exit`/abort), or execution may have failed before finalization. Check process output and stderr.
- **CUDA event setup/record/synchronization/read error:** The diagnostic identifies the CUDA operation and launch site where available. Check CUDA context/stream lifetime and runtime error output. If source destroys the context before the events can be read, use a caller where finalization can happen before destruction.
- **Finalizer count differs from parsed sample count:** The profiler reports a protocol/parser mismatch. Keep the raw `KP_PROFILE_*` records and report the exact run; ordinary application output is kept separate from those records.
- **No independent reference:** A profile may confirm execution and timing while still reporting “Result correctness not independently verified.” Run a separate test/oracle before claiming correctness.

`.cuh` headers and `.cu` files without a supported `main` need a caller. Set `kernelpilot.cudaProfileTranslationUnit` to an appropriate workspace-relative `.cu` file if auto-discovery cannot find one unique caller. The caller must invoke the selected implementation using the actual intended arguments and configuration.

## Isolation refusal

KernelPilot uses a reduced environment, resource limits, timeouts, and Bubblewrap where supported for candidate runtime. If the filesystem/process namespace preflight fails, profiling or benchmark execution is refused. The compiler path is resource-limited but is not filesystem/network isolated. Use a disposable machine for code you do not trust; do not weaken isolation settings.

## Filing a useful issue

The repository's issue tracker is enabled. Report the exact command, extension version/commit, VS Code and OS versions, compiler/provider versions, and the relevant status lines. Include a minimal reproducer when possible. Remove credentials, private source, personal data, and sensitive paths before posting logs or experiment artifacts.
