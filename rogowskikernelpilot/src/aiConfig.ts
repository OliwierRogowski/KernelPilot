import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

export type ConfiguredProvider = 'ollama' | 'openai-compatible';

export interface ModelConfiguration {
    provider: ConfiguredProvider;
    endpoint: string;
    apiKey?: string;
    model: string;
    timeoutMs: number;
    temperature: number;
    maxTokens: number;
}

export interface ModelSettingsFallback {
    provider?: string;
    endpoint?: string;
    model?: string;
}

export async function loadWorkspaceEnv(workspaceRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
    let contents: string;
    try {
        contents = await readFile(path.join(workspaceRoot, '.env'), 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {return;}
        throw new Error(`Could not read workspace .env (${(error as NodeJS.ErrnoException).code ?? 'I/O error'}).`);
    }
    for (const line of contents.split(/\r?\n/)) {
        const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        // Empty inherited variables commonly come from desktop launch environments;
        // treat them as unset so the workspace .env can provide the actual value.
        if (!match || (Object.hasOwn(env, match[1]) && env[match[1]] !== '')) {continue;}
        let value = match[2];
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        } else {
            value = value.replace(/\s+#.*$/, '').trim();
        }
        env[match[1]] = value;
    }
}

export function resolveModelConfiguration(
    settings: ModelSettingsFallback,
    env: NodeJS.ProcessEnv = process.env
): ModelConfiguration {
    const providerValue = (env.KERNELPILOT_AI_PROVIDER ?? settings.provider ?? 'openai-compatible').trim();
    if (providerValue !== 'ollama' && providerValue !== 'openai-compatible') {
        throw new Error('KERNELPILOT_AI_PROVIDER must be "ollama" or "openai-compatible".');
    }
    const timeoutMs = parseBoundedInteger(env.KERNELPILOT_AI_TIMEOUT, 120000, 1000, 600000, 'KERNELPILOT_AI_TIMEOUT');
    const maxTokens = parseBoundedInteger(env.KERNELPILOT_AI_MAX_TOKENS, 8192, 1, 131072, 'KERNELPILOT_AI_MAX_TOKENS');
    const temperature = env.KERNELPILOT_AI_TEMPERATURE === undefined ? 0.1 : Number(env.KERNELPILOT_AI_TEMPERATURE);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
        throw new Error('KERNELPILOT_AI_TEMPERATURE must be a number from 0 to 2.');
    }
    return {
        provider: providerValue,
        endpoint: env.KERNELPILOT_AI_BASE_URL?.trim() || settings.endpoint?.trim() || 'https://api.meta.ai/v1',
        apiKey: env.KERNELPILOT_AI_API_KEY ?? env.KERNELPILOT_API_KEY,
        model: env.KERNELPILOT_AI_MODEL?.trim() || settings.model?.trim() || 'muse-spark-1.3',
        timeoutMs,
        temperature,
        maxTokens
    };
}

function parseBoundedInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
    if (raw === undefined || raw.trim() === '') {return fallback;}
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
    }
    return parsed;
}
