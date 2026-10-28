import * as assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadWorkspaceEnv, resolveModelConfiguration } from '../aiConfig';

suite('AI configuration', () => {
    test('loads only missing environment values from a workspace .env', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'kernelpilot-env-'));
        try {
            await writeFile(path.join(root, '.env'), 'KERNELPILOT_AI_PROVIDER=openai-compatible\nKERNELPILOT_AI_API_KEY="local-placeholder"\n# ignored\n');
            const env: NodeJS.ProcessEnv = { KERNELPILOT_AI_PROVIDER: 'ollama' };
            await loadWorkspaceEnv(root, env);
            assert.strictEqual(env.KERNELPILOT_AI_PROVIDER, 'ollama');
            assert.strictEqual(env.KERNELPILOT_AI_API_KEY, 'local-placeholder');
        } finally {await rm(root, { recursive: true, force: true });}
    });

    test('resolves one provider/model configuration and validates bounded options', () => {
        const config = resolveModelConfiguration({ provider: 'ollama', endpoint: 'http://localhost:11434', model: 'settings-model' }, {
            KERNELPILOT_AI_PROVIDER: 'openai-compatible', KERNELPILOT_AI_BASE_URL: 'https://api.example.invalid',
            KERNELPILOT_AI_MODEL: 'meta-open-weight', KERNELPILOT_AI_API_KEY: 'not-a-real-key',
            KERNELPILOT_AI_TIMEOUT: '45000', KERNELPILOT_AI_TEMPERATURE: '0.3', KERNELPILOT_AI_MAX_TOKENS: '4096'
        });
        assert.deepStrictEqual(config, {
            provider: 'openai-compatible', endpoint: 'https://api.example.invalid', apiKey: 'not-a-real-key',
            model: 'meta-open-weight', timeoutMs: 45000, temperature: 0.3, maxTokens: 4096
        });
        assert.throws(() => resolveModelConfiguration({}, { KERNELPILOT_AI_TIMEOUT: '0' }), /must be an integer/);
        assert.throws(() => resolveModelConfiguration({}, { KERNELPILOT_AI_PROVIDER: 'meta-native' }), /must be/);
    });
});
