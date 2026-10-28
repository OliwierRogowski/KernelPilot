import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { buildGenericCudaBenchmarkTranslationUnit, validateGenericCudaAdapter } from '../genericCudaHarness';
import { parseCudaVerificationResults } from '../cudaMetrics';

const execFileAsync = promisify(execFile);
const sourcePath = path.resolve(__dirname, '../..', 'examples', 'array_sum.cpp');
const adapterPath = path.resolve(__dirname, '../..', 'examples', 'array_sum.cuda-adapter.cuh');

suite('generic CUDA adapter runner', () => {
    test('supports main-only transform_reduce with a source-anchored CPU oracle', async () => {
        const valid = await readFile(adapterPath, 'utf8');
        const source = `#include <numeric>\n#include <functional>\n#include <vector>\nint main() { std::vector<float> values(8); double total = std::transform_reduce(values.begin(), values.end(), 0.0, std::plus<>{}, [](float x) { return static_cast<double>(x) * x; }); return static_cast<int>(total); }`;
        const mainOnlyAdapter = valid.replace(
            'return {static_cast<double>(arraySum(hValues_, n_))};',
            'return {std::transform_reduce(hValues_, hValues_ + n_, 0.0, std::plus<>{}, [](float x) { return static_cast<double>(x) * x; })};'
        );
        assert.deepStrictEqual(validateGenericCudaAdapter(mainOnlyAdapter, undefined, source), []);
        const invalidOracle = mainOnlyAdapter.replace(/return \{std::transform_reduce[\s\S]*?\};/, 'return {0.0};');
        assert.match(validateGenericCudaAdapter(invalidOracle, undefined, source).join(','), /reference\(\) must compute/);
        assert.throws(() => buildGenericCudaBenchmarkTranslationUnit(source, invalidOracle, true), /reference\(\) must compute/);
    });

    test('preserves the original execution policy in the CPU oracle', async () => {
        const valid = await readFile(adapterPath, 'utf8');
        const source = `#include <execution>\n#include <numeric>\n#include <functional>\n#include <vector>\nint main() { std::vector<float> values(8); double total = std::transform_reduce(std::execution::par, values.begin(), values.end(), 0.0, std::plus<>{}, [](float x) { return static_cast<double>(x) * x; }); return static_cast<int>(total); }`;
        const adapter = valid.replace(
            'return {static_cast<double>(arraySum(hValues_, n_))};',
            'return {std::transform_reduce(std::execution::par, hValues_, hValues_ + n_, 0.0, std::plus<>{}, [](float x) { return static_cast<double>(x) * x; })};'
        );
        assert.deepStrictEqual(validateGenericCudaAdapter(adapter, undefined, source), []);
        const changedPolicy = adapter.replace('std::execution::par, hValues_', 'hValues_');
        assert.match(validateGenericCudaAdapter(changedPolicy, undefined, source).join(','), /preserve the source std::execution::par policy/);
    });

    test('rejects absent kernel descriptors and incomplete lifecycle contracts', async () => {
        const valid = await readFile(adapterPath, 'utf8');
        assert.deepStrictEqual(validateGenericCudaAdapter(valid), []);
        assert.match(validateGenericCudaAdapter(valid.replace('arraySum(hValues_, n_)', '0'), 'arraySum').join(','), /direct call to original CPU target/);
        const collidingHook = valid.replace('std::vector<KernelPilotCopy> h2dCopies()', 'std::vector<KernelPilotCopy> h2dCopies');
        assert.match(validateGenericCudaAdapter(collidingHook).join(','), /h2dCopies.*exact signature/);
        const misplacedKernel = valid.replace('__global__ void kpArraySumKernel', 'class KernelPilotGeneratedAdapter { __global__ void kpArraySumKernel');
        assert.match(validateGenericCudaAdapter(misplacedKernel).join(','), /namespace-level __global__/);
        assert.throws(() => buildGenericCudaBenchmarkTranslationUnit('#include <vector>', valid.replace('void cleanup() {', 'void dispose() {')),
            /cleanup\(\)/);
        assert.throws(() => buildGenericCudaBenchmarkTranslationUnit('#include <vector>', valid.replace('std::vector<double> reference()', 'std::vector<double> fakeOracle()')),
            /reference\(\) CPU oracle/);
    });

    test('does not accept an incomplete or merely fenced CUDA fragment as an adapter', async () => {
        const valid = await readFile(adapterPath, 'utf8');
        const truncated = valid.slice(0, Math.floor(valid.length / 2));
        assert.ok(validateGenericCudaAdapter(truncated).length > 0);
        assert.throws(() => buildGenericCudaBenchmarkTranslationUnit('#include <vector>', truncated), /Invalid generated CUDA adapter/);
        assert.throws(() => buildGenericCudaBenchmarkTranslationUnit('#include <vector>', '```cpp\n__global__ void partial() {\n```'), /Invalid generated CUDA adapter/);
    });

    test('runs arraySum through the runner on a real GPU and rejects faulty output', async function () {
        this.timeout(120000);
        try {
            await execFileAsync(process.env.NVCC || 'nvcc', ['--version'], { timeout: 5000 });
            const { stdout } = await execFileAsync(process.env.NVIDIA_SMI || 'nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { timeout: 5000 });
            assert.ok(stdout.trim(), 'GPU device must be present; CUDA success cannot be simulated');
        } catch { this.skip(); return; }

        const source = await readFile(sourcePath, 'utf8');
        const directory = await mkdtemp(path.join(os.tmpdir(), 'kernelpilot-generic-cuda-'));
        try {
            const run = async (name: string, adapter: string, shouldPass: boolean, failurePattern = /differs from CPU oracle/): Promise<string> => {
                const cu = path.join(directory, `${name}.cu`); const exe = path.join(directory, name);
                await writeFile(cu, buildGenericCudaBenchmarkTranslationUnit(source, adapter), 'utf8');
                await execFileAsync(process.env.NVCC || 'nvcc', ['-std=c++17','-O2',cu,'-o',exe], { timeout: 60000 });
                try {
                    const { stdout } = await execFileAsync(exe, [], { timeout: 30000 });
                    if (!shouldPass) { assert.fail('Mutated result unexpectedly passed mathematical verification'); }
                    return stdout;
                } catch (error) {
                    if (shouldPass) { throw error; }
                    const diagnostics = String((error as { stderr?: string }).stderr ?? error);
                    assert.match(diagnostics, failurePattern);
                    return diagnostics;
                }
            };
            const validAdapter = await readFile(adapterPath, 'utf8');
            const output = await run('valid', validAdapter, true);
            assert.match(output, /KP_DEVICE,OK,[1-9]\d*/);
            assert.match(output, /KP_VERIFY_RESULT,64,PASS,-238/);
            assert.match(output, /KP_VERIFY_RESULT,128,PASS,-231/);
            assert.match(output, /KP_VERIFY_RESULT,256,PASS,-189/);
            const expectedChecksums = [{ size: 64, checksum: -238 }, { size: 128, checksum: -231 }, { size: 256, checksum: -189 }];
            assert.deepStrictEqual(parseCudaVerificationResults(output), expectedChecksums);
            const mutatedChecksumOutput = output.replace('KP_VERIFY_RESULT,64,PASS,-238', 'KP_VERIFY_RESULT,64,PASS,-237');
            assert.throws(() => assert.deepStrictEqual(parseCudaVerificationResults(mutatedChecksumOutput), expectedChecksums));
            for (const size of [64,128,256]) {
                for (const phase of ['h2d','kernel','d2h','end_to_end']) {
                    assert.equal((output.match(new RegExp(`KP_METRIC,CUDA,${phase},${size},(?:[0-9]|10),`, 'g')) ?? []).length, 11);
                }
            }
            const faulty = await run('faulty', validAdapter.replace('local += values[index];', 'local += values[index] + 1;'), false);
            assert.match(faulty, /differs from CPU oracle/);
            const noLaunch = await run('no-launch', validAdapter.replace(
                'launchDescriptors_.push_back(kernelpilotKernel(\n            reinterpret_cast<const void*>(kpArraySumKernel), dim3(1), dim3(256), kernelArgs_.data()));',
                '(void)kernelpilotKernel(reinterpret_cast<const void*>(kpArraySumKernel), dim3(1), dim3(256), kernelArgs_.data());\n        launchDescriptors_.clear();'), false,
            /must provide H2D, kernel, and D2H descriptors/);
        } finally { await rm(directory, { recursive: true, force: true }); }
    });
});
