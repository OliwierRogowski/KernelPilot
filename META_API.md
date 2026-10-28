# OpenAI-compatible provider configuration

KernelPilot uses the `openai-compatible` provider implementation for chat-completions endpoints. This is a protocol adapter, not a provider-specific integration or guarantee of account access. Endpoint and model availability must be confirmed with the service selected by the user.

The repository's `.env.example` shows the current default endpoint and model values with a placeholder credential. Before using those values, confirm that the provider account accepts the configured protocol, model identifier, and authentication method. A successful **KernelPilot: Test configured model connection** means only that a real request returned a response; it does not validate generated CUDA code.

1. Obtain a credential directly from the provider, if required.
2. Copy `.env.example` to `.env` at the KernelPilot repository root and replace the placeholder locally.
3. Keep `.env` private and untracked. Never paste the key into source, reports, tests, logs, issues, or `.env.example`.
4. Run **KernelPilot: Test configured model connection** and review its result.

The extension sends OpenAI-compatible credentials as a bearer authorization header over HTTPS. Remote non-local endpoints must use HTTPS. Do not place credentials, query parameters, or fragments in the endpoint URL. See [Configuration](docs/configuration.md) for environment-variable precedence, endpoint path handling, response formats, retries, and supported settings.

Ollama is also supported with its chat protocol. Other provider APIs may use different schemas and are not supported by this adapter unless they implement the accepted OpenAI-compatible request/response subset.
