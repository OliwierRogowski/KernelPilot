# KernelPilot

KernelPilot is a Visual Studio Code extension for analyzing C/C++ code, exploring CUDA parallelization, generating CPU/CUDA implementations, and benchmarking them with local AI assistance.

## AI models

I currently use **Qwen 2.5 Coder 3B** through Ollama for code generation and benchmark tasks. The workspace configuration selects `qwen2.5-coder:3b`. The extension also supports choosing a different model through its settings.

For the next stage, I plan to evaluate and use a **Meta open-weight model** (from the Llama family); the exact model will be selected after testing it with KernelPilot's coding and benchmark workflows.

See [the extension README](rogowskikernelpilot/README.md) for features, setup requirements, and usage instructions.
