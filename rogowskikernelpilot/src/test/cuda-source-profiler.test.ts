import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { buildCudaEventProfilerTranslationUnit, findCudaLaunchSites, isCudaProfileFile, parseCudaKernelEventSamples, parseCudaRuntimeSummaries, planCudaSourceProfile } from '../cudaSourceProfiler';
import { resolveCudaCompileConfiguration, withCudaArchitecture } from '../cudaProfileConfiguration';

const execFileAsync = promisify(execFile);

suite('Existing CUDA source profiler', () => {
    test('recognizes CUDA extension and editor language identifiers for .cu and .cuh', () => {
        assert.strictEqual(isCudaProfileFile('/workspace/kernel.cu', 'cpp'), true);
        assert.strictEqual(isCudaProfileFile('/workspace/kernel.cuh', 'cpp'), true);
        assert.strictEqual(isCudaProfileFile('/workspace/kernel.cpp', 'cuda-cpp'), true);
    });

    test('distinguishes a runnable translation unit, a host wrapper, a header, and a kernel missing launch parameters', () => {
        const wrapper = '__global__ void add(int* x) {}\nvoid run(int* x) { add<<<1, 32>>>(x); }\nint main() { int* x; run(x); return 0; }';
        assert.strictEqual(planCudaSourceProfile('/workspace/sample.cu', wrapper).kind, 'standalone');
        assert.strictEqual(planCudaSourceProfile('/workspace/sample.cuh', '__global__ void add(int* x) {}').kind, 'translation-unit-required');
        assert.strictEqual(planCudaSourceProfile('/workspace/kernel.cu', '__global__ void add(int* x) {}', '__global__ void add(int* x) {}').kind, 'launch-parameters-required');
        assert.throws(() => buildCudaEventProfilerTranslationUnit('__global__ void add(int* x) {}'), /main function/);
    });

    test('finds multiple launch sites, including stream/shared configuration and host-wrapper calls', () => {
        const source = `__global__ void add(int* x) {}\nvoid run(int* x, cudaStream_t stream) {\n add<<<dim3(2, 1), dim3(64), 0, stream>>>(x);\n add<<<4, 32>>>(x);\n}`;
        const sites = findCudaLaunchSites(source);
        assert.deepStrictEqual(sites.map(site => site.kernel), ['add', 'add']);
        assert.deepStrictEqual(sites.map(site => site.siteId), [0, 1]);
        assert.strictEqual(sites[0].grid, 'dim3(2, 1)');
        assert.strictEqual(sites[0].block, 'dim3(64)');
        assert.strictEqual(sites[0].stream, 'stream');
        assert.strictEqual(sites[1].stream, 'nullptr');
    });

    test('reuses project compile settings and honors the configured GPU architecture', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'kernelpilot-cuda-config-'));
        try {
            const source = path.join(root, 'main.cu');
            await writeFile(source, 'int main() {}');
            await writeFile(path.join(root, 'compile_commands.json'), JSON.stringify([{
                directory: root, file: source,
                arguments: ['nvcc', '-std=c++20', '-I', 'include', '-DVALUE=7', '-arch=sm_75', '-c', source, '-o', 'main.o']
            }]));
            const configuration = await resolveCudaCompileConfiguration(root, source);
            assert.deepStrictEqual(configuration.arguments, ['-std=c++20', '-I', 'include', '-DVALUE=7', '-arch=sm_75', '-I', root, '-I', root]);
            assert.deepStrictEqual(withCudaArchitecture(configuration.arguments, 'sm_86').filter(arg => arg.startsWith('-arch')), ['-arch=sm_86']);
            assert.match(configuration.origin, /compile_commands\.json/);
        } finally {await rm(root, { recursive: true, force: true });}
    });

    test('uses VS Code include paths, defines, and language standard when no compile database exists', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'kernelpilot-cuda-properties-'));
        try {
            await import('node:fs/promises').then(({ mkdir }) => mkdir(path.join(root, '.vscode'), { recursive: true }));
            const source = path.join(root, 'kernel.cu'); await writeFile(source, 'int main() {}');
            await writeFile(path.join(root, '.vscode', 'c_cpp_properties.json'), JSON.stringify({ configurations: [{
                includePath: ['${workspaceFolder}/headers'], defines: ['FEATURE=1'], cppStandard: 'c++20'
            }] }));
            const config = await resolveCudaCompileConfiguration(root, source);
            assert.ok(config.arguments.includes('-std=c++20'));
            assert.ok(config.arguments.includes(path.join(root, 'headers')));
            assert.ok(config.arguments.includes('-DFEATURE=1'));
            assert.match(config.origin, /c_cpp_properties\.json/);
        } finally {await rm(root, { recursive: true, force: true });}
    });

    test('compiles and profiles the original kernel calls with CUDA events on a real GPU', async function () {
        this.timeout(120000);
        try {
            await execFileAsync(process.env.NVCC || 'nvcc', ['--version'], { timeout: 5000 });
            const gpu = await execFileAsync(process.env.NVIDIA_SMI || 'nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { timeout: 5000 });
            assert.ok(gpu.stdout.trim(), 'A real CUDA GPU is required; this test does not simulate GPU execution.');
        } catch { this.skip(); return; }

        const source = `#include <cuda_runtime.h>\n#include <cstdio>\n#include <vector>\n__global__ void originalAdd(int* values, int n, int delta) { int i = blockIdx.x * blockDim.x + threadIdx.x; if (i < n) values[i] += delta; }\nstatic void hostWrapper(int* values, int n) { originalAdd<<<(n + 127) / 128, 128>>>(values, n, 1); originalAdd<<<(n + 127) / 128, 128>>>(values, n, 2); }\nint main() { const int n = 1024; int* device = nullptr; if (cudaMalloc(&device, n * sizeof(int)) != cudaSuccess) return 2; hostWrapper(device, n); auto status = cudaDeviceSynchronize(); cudaFree(device); return status == cudaSuccess ? 0 : 3; }`;
        const directory = await mkdtemp(path.join(os.tmpdir(), 'kernelpilot-cuda-profile-'));
        try {
            const built = buildCudaEventProfilerTranslationUnit(source);
            assert.match(built.translationUnit, /kernelpilotRecordLaunch\(0, "originalAdd"/);
            assert.match(built.translationUnit, /KP_PROFILE_RUN/);
            const cu = path.join(directory, 'profile.cu'); const exe = path.join(directory, 'profile');
            await writeFile(cu, built.translationUnit, 'utf8');
            await execFileAsync(process.env.NVCC || 'nvcc', ['-std=c++17', '-O2', cu, '-o', exe], { timeout: 60000 });
            const run = await execFileAsync(exe, [], { timeout: 30000 });
            const samples = parseCudaKernelEventSamples(run.stdout);
            assert.strictEqual(samples.length, 2);
            assert.ok(samples.every(sample => sample.kernel === 'originalAdd' && sample.milliseconds > 0));
            assert.deepStrictEqual(samples.map(sample => sample.grid), [[8, 1, 1], [8, 1, 1]]);
            assert.deepStrictEqual(samples.map(sample => sample.block), [[128, 1, 1], [128, 1, 1]]);
            assert.deepStrictEqual(samples.map(sample => sample.invocation), [0, 1]);
            assert.deepStrictEqual(samples.map(sample => sample.siteId), [0, 1]);
            assert.deepStrictEqual(parseCudaRuntimeSummaries(run.stdout), [{ kernelLaunches: 2, asyncCopies: 0 }]);
        } finally {await rm(directory, { recursive: true, force: true });}
    });

    test('flushes pending events before the original program resets the CUDA context', async function () {
        this.timeout(120000);
        try {
            await execFileAsync(process.env.NVCC || 'nvcc', ['--version'], { timeout: 5000 });
            const gpu = await execFileAsync(process.env.NVIDIA_SMI || 'nvidia-smi', ['-L'], { timeout: 5000 });
            assert.ok(gpu.stdout.trim());
        } catch { this.skip(); return; }
        const directory = await mkdtemp(path.join(os.tmpdir(), 'kernelpilot-cuda-reset-profile-'));
        try {
            const source = `#include <cuda_runtime.h>\n__global__ void beforeReset() {}\nint main() { beforeReset<<<1, 1>>>(); return cudaDeviceReset() == cudaSuccess ? 0 : 1; }`;
            const built = buildCudaEventProfilerTranslationUnit(source);
            assert.match(built.translationUnit, /kernelpilotFlushLaunches\(\); return cudaDeviceReset\(\)/);
            const cu = path.join(directory, 'profiled_original.cu'); const exe = path.join(directory, 'reset-profile');
            await writeFile(cu, built.translationUnit, 'utf8');
            await execFileAsync(process.env.NVCC || 'nvcc', ['-std=c++17', '-O2', cu, '-o', exe], { timeout: 60000 });
            const result = await execFileAsync(exe, [], { timeout: 30000 });
            assert.strictEqual(parseCudaKernelEventSamples(result.stdout).length, 1);
            assert.deepStrictEqual(parseCudaRuntimeSummaries(result.stdout), [{ kernelLaunches: 1, asyncCopies: 0 }, { kernelLaunches: 0, asyncCopies: 0 }]);
        } finally {await rm(directory, { recursive: true, force: true });}
    });

    test('profiles a .cuh kernel through the runnable .cu translation unit that includes it', async function () {
        this.timeout(120000);
        try {
            await execFileAsync(process.env.NVCC || 'nvcc', ['--version'], { timeout: 5000 });
            const { stdout } = await execFileAsync(process.env.NVIDIA_SMI || 'nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { timeout: 5000 });
            assert.ok(stdout.trim());
        } catch { this.skip(); return; }
        const directory = await mkdtemp(path.join(os.tmpdir(), 'kernelpilot-cuh-profile-'));
        try {
            const header = path.join(directory, 'only_kernel.cuh');
            const caller = path.join(directory, 'caller.cu');
            await writeFile(header, '__global__ void headerKernel(int* values) { values[threadIdx.x] += 1; }\n');
            const callerSource = `#include <cuda_runtime.h>\n#include "only_kernel.cuh"\nint main() { int* values = nullptr; if (cudaMalloc(&values, 32 * sizeof(int)) != cudaSuccess) return 2; headerKernel<<<1, 32>>>(values); const auto status = cudaDeviceSynchronize(); cudaFree(values); return status == cudaSuccess ? 0 : 3; }`;
            assert.strictEqual(planCudaSourceProfile(header, '__global__ void headerKernel(int* values) {}').kind, 'translation-unit-required');
            const built = buildCudaEventProfilerTranslationUnit(callerSource);
            const profiled = path.join(directory, 'profiled.cu'); const exe = path.join(directory, 'header-profile');
            await writeFile(profiled, built.translationUnit, 'utf8');
            await execFileAsync(process.env.NVCC || 'nvcc', ['-std=c++17', '-I', directory, '-O2', profiled, '-o', exe], { timeout: 60000 });
            const run = await execFileAsync(exe, [], { timeout: 30000 });
            const samples = parseCudaKernelEventSamples(run.stdout);
            assert.strictEqual(samples.length, 1);
            assert.strictEqual(samples[0].kernel, 'headerKernel');
            assert.deepStrictEqual(samples[0].block, [32, 1, 1]);
        } finally {await rm(directory, { recursive: true, force: true });}
    });
});
