import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { parseCudaMetricSamples, validateCudaRunOutput } from '../cudaMetrics';
import { buildMatmulCudaBenchmarkTranslationUnit } from '../matmulCudaHarness';

const execFileAsync = promisify(execFile);
const nvcc = process.env.KERNELPILOT_NVCC || '/usr/local/cuda/bin/nvcc';

suite('Deterministic CUDA matmul benchmark harness', () => {
    test('builds a real GPU kernel path that calls the original CPU implementation as its oracle', () => {
        const unit = buildMatmulCudaBenchmarkTranslationUnit('int main() { return 0; }');
        assert.match(unit, /__global__ void kernelpilotMatrixMultiplicationKernel/);
        assert.match(unit, /kernelpilotUserMatrixMultiplicationCPU/);
        assert.match(unit, /static std::vector<int> kernelpilotCudaMatmulReference/);
        assert.match(unit, /kernelpilotRequireExact\(cpuReferenceCandidate, expected, "Original CPU result vs independent reference", n\)/);
        assert.match(unit, /kernelpilotRequireExact\(actual, expected, "CUDA result", n\)/);
        assert.match(unit, /const long long actualChecksum = kernelpilotChecksum\(actual\)/);
        assert.match(unit, /checksums\.emplace_back\(n, lastVerifiedGpuChecksum\)/);
        assert.match(unit, /for \(int n : \{70, 128, 256\}\)/);
        assert.match(unit, /cudaEventElapsedTime/);
        assert.match(unit, /cudaMemcpyAsync/);
        assert.doesNotMatch(unit, /KP_BENCH_CUDA/);
        assert.match(unit, /KP_METRIC,/);
    });

    test('compiles and runs matmul on a CUDA device with exact CPU/GPU agreement and phase samples', async function () {
        this.timeout(180000);
        const sourcePath = path.resolve(__dirname, '../..', 'examples', 'matmul.cpp');
        const source = await readFile(sourcePath, 'utf8');
        const directory = await mkdtemp(path.join(os.tmpdir(), 'kernelpilot-matmul-cuda-'));
        try {
            await writeFile(path.join(directory, 'matmul.cu'), buildMatmulCudaBenchmarkTranslationUnit(source), 'utf8');
            await execFileAsync(nvcc, ['--version'], { timeout: 10000 });
            await execFileAsync(nvcc, ['-std=c++17', '-O3', '-DNDEBUG', path.join(directory, 'matmul.cu'), '-o', path.join(directory, 'matmul')],
                { timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
            const { stdout } = await execFileAsync(path.join(directory, 'matmul'), [], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
            assert.deepStrictEqual(validateCudaRunOutput(stdout), [70, 128, 256]);
            const samples = parseCudaMetricSamples(stdout);
            for (const phase of ['h2d', 'kernel', 'd2h', 'end_to_end'] as const) {
                assert.strictEqual(samples.filter(item => item.backend === 'CUDA' && item.phase === phase).length, 15);
            }
            assert.strictEqual(samples.filter(item => item.backend === 'CPU' && item.phase === 'compute').length, 15);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
