# Configuration

## AI provider and model

KernelPilot supports `ollama` and a limited `openai-compatible` chat-completions protocol. It does not bundle a model. Configure these values in the process environment or in `.env` at the KernelPilot repository root. The root `.env.example` contains placeholders only.

```dotenv
KERNELPILOT_AI_PROVIDER=openai-compatible
KERNELPILOT_AI_BASE_URL=https://your-provider.example/v1
KERNELPILOT_AI_API_KEY=your-api-key-here
KERNELPILOT_AI_MODEL=your-model-id
KERNELPILOT_AI_TIMEOUT=120000
KERNELPILOT_AI_TEMPERATURE=0.1
KERNELPILOT_AI_MAX_TOKENS=8192
```

For a local Ollama server, use `KERNELPILOT_AI_PROVIDER=ollama`, set the base URL to the local server, and choose a model installed there. A key is not required for Ollama.

Precedence is: non-empty process environment, then missing values loaded from `.env`, then the extension settings for provider, endpoint, and model. The legacy `KERNELPILOT_API_KEY` remains a fallback for `KERNELPILOT_AI_API_KEY`.

| Environment variable | Behavior |
|---|---|
| `KERNELPILOT_AI_PROVIDER` | `ollama` or `openai-compatible`; default is `openai-compatible`. |
| `KERNELPILOT_AI_BASE_URL` | Provider base URL. Chat paths are added when absent. Remote OpenAI-compatible URLs must use HTTPS; HTTP is allowed for localhost. URLs containing credentials, query strings, or fragments are rejected. |
| `KERNELPILOT_AI_API_KEY` | Bearer credential for OpenAI-compatible endpoints. Keep it private. |
| `KERNELPILOT_AI_MODEL` | Provider-specific model identifier. The current code fallback is `muse-spark-1.3`; availability depends on the configured provider/account. |
| `KERNELPILOT_AI_TIMEOUT` | Request timeout in milliseconds; accepted range 1,000–600,000. |
| `KERNELPILOT_AI_TEMPERATURE` | Number from 0 to 2; default 0.1. |
| `KERNELPILOT_AI_MAX_TOKENS` | Integer from 1 to 131,072; default 8,192. Provider-specific effective limits may be lower. |

OpenAI-compatible responses can be strings or text-part arrays. Empty, malformed, rejected, rate-limited, and truncated responses produce explicit errors. Truncated completions may be retried up to two times with a bounded larger output budget. This is transport handling, not a guarantee that a response is correct or complete.

Run **KernelPilot: Test configured model connection** to make a live request. Unit tests use local mock endpoints; a passing unit test does not confirm credentials or access at your provider.

## CUDA and analyzer settings

These are actual VS Code settings contributed by `package.json`:

| Setting | Default | Purpose |
|---|---|---|
| `kernelpilot.cudaCompiler` | `nvcc` | CUDA compiler executable. |
| `kernelpilot.cudaArchitecture` | Empty | Optional target such as `sm_86`. Some workflows detect the installed GPU architecture when available. |
| `kernelpilot.cudaValidationHarness` | Empty | Workspace-relative independent `.cu` harness for the existing CUDA experiment workflow. |
| `kernelpilot.cudaProfileTranslationUnit` | Empty | Workspace-relative `.cu` caller for profiling a `.cuh` or source file without a runnable `main` when auto-discovery is ambiguous. |
| `kernelpilot.cudaProfileWarmupRuns` | `1` | Full-program warmup executions for direct existing-CUDA profiling; range 0–10. |
| `kernelpilot.cudaProfileRepetitions` | `5` | Full-program measured executions for direct existing-CUDA profiling; range 1–50. |
| `kernelpilot.benchmarkCompiler` | Empty | C/C++ compiler override; defaults to `gcc` for C and `g++` for C++. |
| `kernelpilot.cpuCompiler` | `g++` | Compiler used to syntax-check generated CPU conversions. |
| `kernelpilot.analyzerPath` | Empty | Native analyzer override; otherwise `native-analyzer/build/kernelpilot-analyzer` under the extension folder. |

For CUDA build configuration, direct profiling first looks for a matching entry in `compile_commands.json`, then `.vscode/c_cpp_properties.json`, then uses defaults. The fallback is not a replacement for the actual build system: complex CMake definitions, generated headers, device-link options, and transitive project dependencies may require a complete project translation unit/configuration.

The experiment harness path must be relative to the opened VS Code workspace. It must include the source using `#include KERNELPILOT_KERNEL_SOURCE` and print one `KP_RESULT,<case>,PASS|FAIL,<median_ms>,<p95_ms>` record for every test case after its own correctness checks and timing procedure. KernelPilot validates record shape and case matching; it cannot prove that the harness is an independent oracle.

## Local files and credentials

Use `.env` for private credentials and keep it untracked. Do not copy real keys into `.env.example`, documentation, tests, experiment manifests, source code, or logs. Review provider logs before sharing them; values should be redacted before opening an issue.
