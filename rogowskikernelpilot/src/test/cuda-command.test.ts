import * as assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

suite('Existing .cu command integration without model credentials', () => {
    test('snapshots the active CUDA file and reports unavailable provider without a fake candidate', async function () {
        this.timeout(30000);
        const root = await mkdtemp(path.join(os.tmpdir(), 'kernelpilot-command-'));
        const source = '__global__ void scale(float* x, int n) { int i = blockIdx.x * blockDim.x + threadIdx.x; if (i < n) x[i] *= 2.0f; }\n';
        const sourcePath = path.join(root, 'user_kernel.cu');
        const envKeys = ['KERNELPILOT_AI_PROVIDER', 'KERNELPILOT_AI_BASE_URL', 'KERNELPILOT_AI_API_KEY', 'KERNELPILOT_AI_MODEL', 'KERNELPILOT_AI_TIMEOUT'] as const;
        const previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
        let folderAdded = false;
        try {
            await writeFile(sourcePath, source, 'utf8');
            const folderReady = new Promise<void>(resolve => {
                const listener = vscode.workspace.onDidChangeWorkspaceFolders(() => {listener.dispose(); resolve();});
                folderAdded = vscode.workspace.updateWorkspaceFolders(0, 0, { uri: vscode.Uri.file(root), name: 'KernelPilot command test' });
            });
            assert.ok(folderAdded, 'temporary test workspace should be added');
            await folderReady;
            process.env.KERNELPILOT_AI_PROVIDER = 'ollama';
            process.env.KERNELPILOT_AI_BASE_URL = 'http://127.0.0.1:1';
            process.env.KERNELPILOT_AI_API_KEY = '';
            process.env.KERNELPILOT_AI_MODEL = 'offline-connectivity-test';
            process.env.KERNELPILOT_AI_TIMEOUT = '1500';
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
            await vscode.window.showTextDocument(document);
            await vscode.commands.executeCommand('rogowskikernelpilot.optimizeCuda');

            const experimentsRoot = path.join(root, '.kernelpilot', 'experiments');
            const experimentIds = await readdir(experimentsRoot);
            assert.strictEqual(experimentIds.length, 1);
            const experiment = path.join(experimentsRoot, experimentIds[0]);
            assert.strictEqual(await readFile(path.join(experiment, 'original.cu'), 'utf8'), source);
            const manifest = JSON.parse(await readFile(path.join(experiment, 'experiment.json'), 'utf8')) as {
                status: string; candidate_source: string | null; validation: { details: string };
            };
            assert.strictEqual(manifest.status, 'cannot_confirm');
            assert.strictEqual(manifest.candidate_source, null);
            assert.match(manifest.validation.details, /Could not connect|timed out/);
            assert.deepStrictEqual(await readdir(experiment), ['experiment.json', 'original.cu']);
        } finally {
            for (const key of envKeys) {
                const previous = previousEnv[key];
                if (previous === undefined) {delete process.env[key];} else {process.env[key] = previous;}
            }
            if (folderAdded) {vscode.workspace.updateWorkspaceFolders(0, 1);}
            await rm(root, { recursive: true, force: true });
        }
    });
});
