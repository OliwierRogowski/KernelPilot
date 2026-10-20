# rogowskikernelpilot README

This is the README for your extension "rogowskikernelpilot". After writing up a brief description, we recommend including the following sections.

## Features

Describe specific features of your extension including screenshots of your extension in action. Image paths are relative to this README file.

For example if there is an image subfolder under your extension project workspace:

\!\[feature X\]\(images/feature-x.png\)

> Tip: Many popular extensions utilize animations. This is an excellent way to show off your extension! We recommend short, focused animations that are easy to follow.

## Requirements

If you have any requirements or dependencies, add a section describing those and how to install and configure them.

## Extension Settings

Include if your extension adds any VS Code settings through the `contributes.configuration` extension point.

For example:

This extension contributes the following settings:

* `myExtension.enable`: Enable/disable this extension.
* `myExtension.thing`: Set to `blah` to do something.

## Known Issues

Calling out known issues can help limit users opening duplicate issues against your extension.

## Release Notes

Users appreciate release notes as you update your extension.

### 1.0.0

Initial release of ...

### 1.0.1

Fixed issue #.

### 1.1.0

Added features X, Y, and Z.

---

## Following extension guidelines

Ensure that you've read through the extensions guidelines and follow the best practices for creating your extension.

* [Extension Guidelines](https://code.visualstudio.com/api/references/extension-guidelines)

## Working with Markdown

You can author your README using Visual Studio Code. Here are some useful editor keyboard shortcuts:

* Split the editor (`Cmd+\` on macOS or `Ctrl+\` on Windows and Linux).
* Toggle preview (`Shift+Cmd+V` on macOS or `Shift+Ctrl+V` on Windows and Linux).
* Press `Ctrl+Space` (Windows, Linux, macOS) to see a list of Markdown snippets.

## For more information

* [Visual Studio Code's Markdown Support](http://code.visualstudio.com/docs/languages/markdown)
* [Markdown Syntax Reference](https://help.github.com/articles/markdown-basics/)

**Enjoy!**

## Native code analysis

Open a C or C++ file, then run **KernelPilot: Analyze current C/C++ file** from the Command Palette. Results appear in the **KernelPilot Analysis** Output channel and include function names, loop read/write variables, indexed array accesses, conditions, function calls, and a heuristic CUDA parallelism rating with reasons. The rating is based on Clang AST facts; it indicates parallelization potential and does not predict runtime speed. Clang parse errors are shown in the same channel.

The native analyzer requires LLVM and Clang development packages. Build it from `native-analyzer` with CMake, then configure `kernelpilot.analyzerPath` if the executable is not at `native-analyzer/build/kernelpilot-analyzer` inside the extension folder:

```sh
cmake -S native-analyzer -B native-analyzer/build
cmake --build native-analyzer/build --target kernelpilot-analyzer
```

## CUDA conversion

Open a C/C++ file, optionally select an algorithm, and run **KernelPilot: Convert file or selection to CUDA**. KernelPilot analyzes the translation unit, asks the configured Ollama coding model to add a CUDA kernel and host wrapper, and saves the result as a `.cu` file. If `nvcc` is installed, it compiles the generated translation unit and asks the model to repair compiler errors before saving. Without `nvcc`, it still saves the generated code and reports that it was not compile-checked. The original CPU implementation remains in the saved file as a reference.

KernelPilot uses Ollama for local AI. In my current workspace, `kernelpilot.codingModel` is set to `qwen2.5-coder:3b` for code generation, benchmark harnesses, and recommendations. The extension's packaged defaults remain `llama4:maverick` for both `kernelpilot.codingModel` and `kernelpilot.chatModel`, so configure the settings to a model installed in Ollama before using it. I plan to evaluate a Meta open-weight model from the Llama family for a future iteration; I have not selected the specific model yet.

## Native benchmarks

Run **KernelPilot: Benchmark file or selection** from the Command Palette with a C/C++ editor open. A non-empty selection chooses the algorithm to benchmark; with no selection, the current file is used. KernelPilot analyzes the current editor contents, asks the configured Ollama model for a CPU harness, compiles and runs it with `gcc`/`g++`, then asks the same model for a backend decision using the source, AST, CPU timings, and detected hardware. The model returns a versioned `cuda_backend_selection` JSON decision: `cpu_only` skips CUDA generation and execution; `benchmark_cuda` generates and verifies a CUDA comparison program. Invalid or uncertain decisions conservatively run the comparison. The report shows the decision, CPU timings, any verified CPU/GPU comparison, and model recommendations. This versioned JSON task is stable input/output for future model fine-tuning.

The decision record uses this schema:

```json
{
	"task": "cuda_backend_selection",
	"schema_version": 1,
	"decision": "cpu_only",
	"confidence": 0.94,
	"reason": "The loop carries a scalar dependency between iterations."
}
```

The model input contains the source/selection, Clang AST facts, summarized CPU timings, and environment fields for CPU, RAM, CUDA compiler, and GPU. Unknown task or schema versions, invalid confidence values, and malformed JSON are rejected; an invalid decision falls back to running CUDA comparison. CUDA comparison requires NVIDIA driver/GPU access and a working `nvcc`; compiler and runtime failures are reported in the KernelPilot Benchmark output.

The benchmark requires the configured native analyzer, a C/C++ compiler, and the Ollama model configured in `kernelpilot.codingModel`. In my workspace this is `qwen2.5-coder:3b`; a fresh extension install uses its packaged default until changed in settings. CUDA comparison additionally requires `nvcc` and a working NVIDIA driver/GPU. Set `kernelpilot.benchmarkCompiler` or `kernelpilot.cudaCompiler` to use different compiler executables. Generated comparison code may need project-specific build configuration when the translation unit has unresolved symbols or external dependencies.

## AI code review and CUDA assistance

Run **KernelPilot: Review code with local AI** to review the current file or selection for correctness, memory safety, performance, and CUDA parallelization suitability. Results appear in the **KernelPilot AI Analysis** output channel. This review uses the configured Ollama coding model and is advisory; it does not compile or execute the code. Run **KernelPilot: CUDA programming help** to open the chat with the current selection or file as context for CUDA kernel, memory, launch, debugging, or optimization questions.

## CUDA-to-CPU conversion

Open a `.cu`, `.cuh`, or C++ file, optionally select code, and run **KernelPilot: Convert CUDA file or selection to CPU**. The local AI generates a CPU-only C++17 translation unit, then the configured `kernelpilot.cpuCompiler` (default `g++`) checks it with `-fsyntax-only` and can repair compiler diagnostics. The result is saved as a `.cpu.cpp` file. Set `kernelpilot.cpuCompiler` if your C++ compiler has a different executable name. This syntax check does not prove behavioral equivalence and may need additional project-specific include paths or build flags.
