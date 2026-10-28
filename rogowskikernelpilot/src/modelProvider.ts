export type ModelProviderKind = 'ollama' | 'openai-compatible';
export type ModelRole = 'system' | 'user' | 'assistant';

export interface ModelMessage {
    role: ModelRole;
    content: string;
}

export interface ModelProviderRequest {
    provider: ModelProviderKind;
    endpoint: string;
    apiKey?: string;
    model: string;
    messages: ModelMessage[];
    options?: Record<string, number>;
    format?: 'json';
    timeoutMs?: number;
}

interface OllamaResponse {
    message?: { content?: string };
    error?: string;
}

interface OpenAICompatibleResponse {
    id?: string;
    model?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    error?: { message?: string; type?: string; code?: string };
    choices?: Array<{ finish_reason?: string | null; message?: {
        content?: string | Array<{ type?: string; text?: string }>;
        refusal?: string;
        reasoning_content?: string;
    } }>;
}

export async function requestModelCompletion(
    request: ModelProviderRequest,
    fetcher: typeof fetch = fetch,
    truncationAttempt = 0
): Promise<string> {
    const model = request.model.trim();
    if (!model) {
        throw new Error('No model identifier is configured.');
    }
    const url = resolveEndpoint(request.provider, request.endpoint);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (request.provider === 'openai-compatible') {
        if (!request.apiKey?.trim()) {
            throw new Error('The selected OpenAI-compatible provider requires KERNELPILOT_AI_API_KEY in the workspace .env or process environment (legacy fallback: KERNELPILOT_API_KEY).');
        }
        headers.Authorization = `Bearer ${request.apiKey.trim()}`;
    }

    const body = request.provider === 'ollama'
        ? {
            model,
            messages: request.messages,
            stream: false,
            ...(request.format ? { format: request.format } : {}),
            ...(request.options ? { options: request.options } : {})
        }
        : {
            model,
            messages: request.messages,
            stream: false,
            ...(request.format ? { response_format: { type: 'json_object' } } : {}),
            ...(request.options ? {
                ...(request.options.num_predict !== undefined
                    ? { max_tokens: Math.min(request.options.num_predict * (2 ** truncationAttempt), 32768) } : {}),
                ...(request.options.temperature !== undefined
                    ? { temperature: request.options.temperature } : {})
            } : {})
        };

    const outputBudget = request.options?.num_predict;
    const requestedOutputBudget = outputBudget === undefined
        ? undefined : Math.min(outputBudget * (2 ** truncationAttempt), 32768);
    let response: Response;
    try {
        response = await fetcher(url, {
            method: 'POST', headers, body: JSON.stringify(body),
            signal: AbortSignal.timeout(request.timeoutMs ?? (outputBudget ? 300000 : 120000))
        });
    } catch (error) {
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined;
        const causeCode = cause && 'code' in cause ? String((cause as NodeJS.ErrnoException).code ?? '') : '';
        const networkDetails = cause
            ? ` (cause=${cause.name}${causeCode ? `, code=${causeCode}` : ''}: ${redact(cause.message, request.apiKey).slice(0, 240)})`
            : '';
        throw new Error(timedOut
            ? `The ${request.provider} request timed out after ${request.timeoutMs ?? 120000} ms.`
            : `Could not connect to the configured ${request.provider} endpoint: ${redact(error instanceof Error ? error.message : 'network error', request.apiKey)}${networkDetails}`);
    }

    if (response.status === 401 || response.status === 403) {
        throw new Error(`${request.provider} rejected the configured credentials (HTTP ${response.status}).`);
    }
    if (response.status === 429) {
        throw new Error(`${request.provider} rate limit reached (HTTP 429). Try again later or check the provider quota.`);
    }
    if (!response.ok) {
        throw new Error(`${request.provider} returned HTTP ${response.status} for model "${model}".`);
    }

    let data: OllamaResponse | OpenAICompatibleResponse;
    try {
        data = await response.json() as OllamaResponse | OpenAICompatibleResponse;
    } catch {
        throw new Error(`${request.provider} returned a malformed JSON response.`);
    }
    if (request.provider === 'openai-compatible') {
        const diagnosticData = data as OpenAICompatibleResponse;
        const diagnosticChoice = diagnosticData.choices?.[0];
        const diagnosticContent = diagnosticChoice?.message?.content;
        const outputCharacters = typeof diagnosticContent === 'string' ? diagnosticContent.length
            : Array.isArray(diagnosticContent) ? diagnosticContent.reduce((n, part) => n + (part.text?.length ?? 0), 0) : 0;
        console.log(`[KernelPilot] Model response diagnostics: ${JSON.stringify({
            provider: request.provider, endpointOrigin: new URL(url).origin, model: diagnosticData.model ?? model,
            responseId: diagnosticData.id ?? null, requestedMaxTokens: requestedOutputBudget ?? null,
            promptCharacters: request.messages.reduce((total, message) => total + message.content.length, 0),
            finishReason: diagnosticChoice?.finish_reason ?? null,
            contentShape: Array.isArray(diagnosticContent) ? 'text-parts' : typeof diagnosticContent,
            contentCharacters: outputCharacters,
            usage: diagnosticData.usage ? {
                promptTokens: diagnosticData.usage.prompt_tokens ?? null,
                completionTokens: diagnosticData.usage.completion_tokens ?? null,
                totalTokens: diagnosticData.usage.total_tokens ?? null
            } : null,
            retry: truncationAttempt
        })}`);
    }
    if (request.provider === 'ollama') {
        const ollamaData = data as OllamaResponse;
        if (ollamaData.error) {
            throw new Error(`Ollama error for model "${model}": ${redact(ollamaData.error, request.apiKey).slice(0, 500)}`);
        }
        const content = ollamaData.message?.content?.trim();
        if (content) {return content;}
    } else {
        const openAIData = data as OpenAICompatibleResponse;
        if (openAIData.error?.message) {
            throw new Error(`${request.provider} error for model "${model}": ${redact(openAIData.error.message, request.apiKey).slice(0, 500)}`);
        }
        const choice = openAIData.choices?.[0];
        const content = choice?.message?.content;
        if (choice?.finish_reason === 'length') {
            const usage = openAIData.usage;
            const metadata = {
                responseId: openAIData.id ?? null, responseModel: openAIData.model ?? null,
                finishReason: choice.finish_reason,
                contentShape: Array.isArray(content) ? 'text-parts' : typeof content,
                contentCharacters: typeof content === 'string' ? content.length : Array.isArray(content) ? content.reduce((n, part) => n + (part.text?.length ?? 0), 0) : 0,
                usage: { promptTokens: usage?.prompt_tokens ?? null, completionTokens: usage?.completion_tokens ?? null, totalTokens: usage?.total_tokens ?? null },
                requestedMaxTokens: requestedOutputBudget ?? null
            };
            if (truncationAttempt < 2 && outputBudget !== undefined && requestedOutputBudget !== undefined && requestedOutputBudget < 32768) {
                const retryRequest = {
                    ...request,
                    messages: truncationAttempt === 0
                        ? [...request.messages, { role: 'system' as const, content: 'Retry: return the complete requested artifact in the shortest valid form. Omit explanation and optional formatting.' }]
                        : request.messages
                };
                return requestModelCompletion(retryRequest, fetcher, truncationAttempt + 1);
            }
            throw new Error(`Configured OpenAI-compatible output was truncated by the provider. ${JSON.stringify(metadata)}; bounded retries exhausted (${truncationAttempt}).`);
        }
        if (typeof content === 'string' && content.trim()) {return content.trim();}
        if (Array.isArray(content)) {
            const text = content.filter(part => part.type === 'text' && typeof part.text === 'string')
                .map(part => part.text).join('').trim();
            if (text) {return text;}
        }
    }
    const choice = (data as OpenAICompatibleResponse).choices?.[0];
    const finish = choice?.finish_reason ? ` finish_reason=${choice.finish_reason}` : '';
    const refusal = choice?.message?.refusal ? ' response includes a refusal.' : '';
    const reasoningOnly = choice?.message?.reasoning_content?.trim() ? ' reasoning content was present but no user-facing content was returned.' : '';
    throw new Error(`${request.provider} returned an empty or unsupported response for model "${model}".${finish}${refusal}${reasoningOnly}`);
}

function redact(value: string, secret?: string): string {
    return secret ? value.split(secret).join('[redacted]') : value;
}

function resolveEndpoint(provider: ModelProviderKind, rawEndpoint: string): string {
    const trimmed = rawEndpoint.trim();
    if (!trimmed) {throw new Error('The model endpoint is empty.');}
    let endpoint: URL;
    try {
        endpoint = new URL(trimmed);
    } catch {
        throw new Error('The model endpoint must be a valid absolute HTTP(S) URL.');
    }
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        throw new Error('Do not put credentials, query parameters, or fragments in the model endpoint URL.');
    }
    if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
        throw new Error('The model endpoint must use HTTP or HTTPS.');
    }
    const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
    if (provider === 'openai-compatible' && endpoint.protocol !== 'https:' && !localHost) {
        throw new Error('OpenAI-compatible endpoints must use HTTPS unless they run on localhost.');
    }
    const basePath = endpoint.pathname.replace(/\/$/, '');
    if (provider === 'ollama') {
        if (!basePath.endsWith('/api/chat')) {
            endpoint.pathname = `${basePath}${basePath.endsWith('/api') ? '/chat' : '/api/chat'}`;
        }
    } else if (!basePath.endsWith('/v1/chat/completions')) {
        endpoint.pathname = `${basePath}${basePath.endsWith('/v1') ? '/chat/completions' : '/v1/chat/completions'}`;
    }
    return endpoint.toString();
}
