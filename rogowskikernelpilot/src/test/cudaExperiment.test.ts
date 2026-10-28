import * as assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { analyzeCudaSource, createCudaExperiment, parseOptimizationProposal, persistCudaProposal, renderCudaExperimentReport, resolveCudaArchitecture } from '../cudaExperiment';
import { requestModelCompletion } from '../modelProvider';

const original = `#include <cuda_runtime.h>\n__global__ void vectorAdd(const float* a, const float* b, float* c, int n) { int i = blockIdx.x * blockDim.x + threadIdx.x; if (i < n) c[i] = a[i] + b[i]; }\n`;

suite('Existing CUDA source workflow', () => {
    test('selects a valid configured or detected CUDA architecture without guessing', () => {
        assert.strictEqual(resolveCudaArchitecture(undefined, 'Example GPU, 8.9, 24576 MiB'), 'sm_89');
        assert.strictEqual(resolveCudaArchitecture('sm_100', 'Example GPU, 8.9, 24576 MiB'), 'sm_100');
        assert.strictEqual(resolveCudaArchitecture(undefined, 'unavailable'), undefined);
        assert.throws(() => resolveCudaArchitecture('compute_90', 'unavailable'), /must use/);
    });

    test('extracts kernel signature and labels lexical findings as hypotheses', () => {
        const analysis = analyzeCudaSource(original);
        assert.strictEqual(analysis.kernels.length, 1);
        assert.strictEqual(analysis.kernels[0].name, 'vectorAdd');
        assert.strictEqual(analysis.kernels[0].parameters.length, 4);
        assert.ok(analysis.evidence.some(item => item.includes('warp divergence')));
        assert.ok(analysis.limitations.some(item => item.includes('not compiler AST')));
    });

    test('validates structured proposal and rejects changes to the public kernel signature', () => {
        const valid = JSON.stringify({
            schema_version: 1, optimized_source: original.replace('int i =', 'const int i ='), summary: 'Make indexing explicit.',
            changes: [{ title: 'Index', rationale: 'No behavior change.', evidence: 'Linear thread index is visible.' }],
            correctness_notes: 'Same inputs and outputs.', benchmark_plan: 'Measure synchronized GPU kernel time.', risks: []
        });
        assert.ok(parseOptimizationProposal(valid, original));
        const keepOriginal = JSON.parse(valid) as Record<string, unknown>;
        keepOriginal.optimized_source = original;
        keepOriginal.changes = [];
        assert.strictEqual(parseOptimizationProposal(JSON.stringify(keepOriginal), original).changes.length, 0);
        const changed = valid.replace('vectorAdd(const float* a, const float* b, float* c, int n)', 'vectorAdd(float* c, int n)');
        assert.throws(() => parseOptimizationProposal(changed, original), /changed or removed/);
        assert.throws(() => parseOptimizationProposal('not JSON', original), /not a JSON object/);
    });

    test('creates immutable original snapshot and unique experiment artifacts', async () => {
        const root = await os.tmpdir();
        const workspace = await import('node:fs/promises').then(fs => fs.mkdtemp(path.join(root, 'kernelpilot-exp-')));
        try {
            const sourcePath = path.join(workspace, 'sample.cu');
            const experiment = await createCudaExperiment(workspace, sourcePath, original, analyzeCudaSource(original), { nvcc: 'unavailable', gpu: 'unavailable' });
            assert.strictEqual(await readFile(path.join(experiment.directory, 'original.cu'), 'utf8'), original);
            assert.strictEqual(experiment.manifest.status, 'analysis_only');
            assert.strictEqual(experiment.manifest.compilation.original, 'not attempted');
            assert.ok(experiment.manifest.original_sha256.length === 64);
            const report = renderCudaExperimentReport(experiment.manifest);
            assert.match(report, /Median speedup: not measured/);
            assert.match(report, /compile-only result does not establish mathematical correctness/i);
        } finally {await rm(workspace, { recursive: true, force: true });}
    });

    test('mocked no-key end-to-end proposal preserves original and writes a separate candidate', async () => {
        const workspace = await import('node:fs/promises').then(fs => fs.mkdtemp(path.join(os.tmpdir(), 'kernelpilot-e2e-')));
        try {
            const originalPath = path.join(workspace, 'user-kernel.cu');
            const experiment = await createCudaExperiment(workspace, originalPath, original, analyzeCudaSource(original), { nvcc: 'unavailable', gpu: 'unavailable' });
            const responsePayload = {
                schema_version: 1,
                optimized_source: original.replace('const int index', 'const int index'),
                summary: 'Retain this simple coalesced vector addition.',
                changes: [], correctness_notes: 'No code change was proposed.',
                benchmark_plan: 'Keep the original unless a measured workload motivates a change.', risks: []
            };
            responsePayload.optimized_source = original.replace('int i =', 'const int i =');
            const modelResponse = await requestModelCompletion({
                provider: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'mock-model',
                messages: [{ role: 'user', content: 'mocked proposal' }], format: 'json'
            }, async (_input, init) => {
                assert.strictEqual(init?.headers && new Headers(init.headers).has('Authorization'), false);
                return new Response(JSON.stringify({ message: { content: JSON.stringify({
                    ...responsePayload,
                    changes: [{ title: 'Explicit index', rationale: 'Keep linear indexing clear.', evidence: 'The source already uses adjacent thread lanes.' }]
                }) } }), { status: 200, headers: { 'content-type': 'application/json' } });
            });
            const proposal = await persistCudaProposal(experiment.directory, experiment.manifest, original, modelResponse);
            assert.ok(proposal.optimized_source !== original);
            assert.strictEqual(await readFile(path.join(experiment.directory, 'original.cu'), 'utf8'), original);
            assert.strictEqual(await readFile(path.join(experiment.directory, 'candidate.cu'), 'utf8'), proposal.optimized_source);
            const manifest = JSON.parse(await readFile(path.join(experiment.directory, 'experiment.json'), 'utf8')) as { status: string; candidate_source: string };
            assert.strictEqual(manifest.status, 'proposal_ready');
            assert.strictEqual(manifest.candidate_source, 'candidate.cu');
        } finally {await rm(workspace, { recursive: true, force: true });}
    });
});
