import * as assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

suite('CUDA source profile command', () => {
    test('profiles existing .cu kernel calls without an AI-generated replacement', async function () {
        this.timeout(120000);
        try {
            await import('node:child_process').then(({ execFileSync }) => execFileSync(process.env.NVCC || 'nvcc', ['--version'], { stdio: 'ignore' }));
            const { stdout } = await import('node:child_process').then(({ execFileSync }) => ({ stdout: execFileSync(process.env.NVIDIA_SMI || 'nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { encoding: 'utf8' }) }));
            assert.ok(stdout.trim(), 'A CUDA GPU is required for the integration test.');
        } catch { this.skip(); return; }

        const directory = await mkdtemp(path.join(os.tmpdir(), 'kernelpilot-profile-command-'));
        const sourcePath = path.join(directory, 'existing.cu');
        const source = `#include <cuda_runtime.h>\n#include <cstdio>\n#include <cstdlib>\n__global__ void userKernel(int* data, int n) { int i = blockIdx.x * blockDim.x + threadIdx.x; if (i < n) data[i] += 1; }\nstatic void userWrapper(int* data, int n, cudaStream_t stream) { userKernel<<<(n + 127) / 128, 128, 0, stream>>>(data, n); userKernel<<<(n + 127) / 128, 128, 0, stream>>>(data, n); }\nint main() { constexpr int n = 512; int* data = nullptr; int* host = nullptr; cudaStream_t stream{}; if (cudaMalloc(&data, n * sizeof(int)) != cudaSuccess || cudaHostAlloc(&host, n * sizeof(int), cudaHostAllocDefault) != cudaSuccess || cudaStreamCreate(&stream) != cudaSuccess) return 2; for (int i = 0; i < n; ++i) host[i] = 1; auto h2d = cudaMemcpyAsync(data, host, n * sizeof(int), cudaMemcpyHostToDevice, stream); userWrapper(data, n, stream); auto d2h = cudaMemcpyAsync(host, data, n * sizeof(int), cudaMemcpyDeviceToHost, stream); auto status = cudaStreamSynchronize(stream); std::printf("Checksum: %d\\n", host[n - 1]); const int result = h2d == cudaSuccess && d2h == cudaSuccess && status == cudaSuccess && host[n - 1] == 3 ? 0 : 3; cudaFree(data); cudaFreeHost(host); cudaStreamDestroy(stream); return result; }`;
        await writeFile(sourcePath, source, 'utf8');
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
        await vscode.window.showTextDocument(document);

        const lines: string[] = [];
        let commandError = '';
        const window = vscode.window as unknown as {
            createOutputChannel: (name: string, options?: { log: boolean }) => vscode.OutputChannel;
            showWarningMessage: (...args: unknown[]) => Promise<unknown>;
            showErrorMessage: (...args: unknown[]) => Promise<unknown>;
        };
        const originalCreate = window.createOutputChannel.bind(vscode.window);
        const originalWarning = window.showWarningMessage.bind(vscode.window);
        const originalError = window.showErrorMessage.bind(vscode.window);
        window.createOutputChannel = (name, options) => {
            const channel = originalCreate(name, options);
            const append = channel.appendLine.bind(channel);
            channel.appendLine = value => {lines.push(value); append(value);};
            return channel;
        };
        window.showWarningMessage = async (...args) => {
            const message = String(args[0] ?? '');
            if (message.includes('will invoke a compiler on user/model-provided source')) {return 'Compile source';}
            if (message.startsWith('Run the existing CUDA program')) {return 'Run isolated CUDA profile';}
            return undefined;
        };
        window.showErrorMessage = async message => {commandError = String(message); return undefined;};
        try {
            await vscode.commands.executeCommand('rogowskikernelpilot.profileBottlenecks');
            assert.strictEqual(commandError, '', [commandError, ...lines].filter(Boolean).join('\n'));
            assert.ok(lines.some(line => line.includes('Detected launch sites: 2 (userKernel, userKernel)')), lines.join('\n'));
            assert.ok(lines.some(line => line.includes('CUDA kernel launch execution confirmed')));
            assert.ok(lines.includes('Result correctness not independently verified.'));
            assert.strictEqual(lines.filter(line => line.startsWith('KP_PROFILE_KERNEL,run=')).length, 10);
            assert.strictEqual(lines.filter(line => line.startsWith('KP_PROFILE_COPY,run=')).length, 10);
            assert.ok(lines.some(line => line.startsWith('H2D cudaMemcpyAsync: 5 calls')));
            assert.ok(lines.some(line => line.startsWith('D2H cudaMemcpyAsync: 5 calls')));
            assert.strictEqual(lines.filter(line => line.includes('stdout: Checksum: 3')).length, 5);
            assert.ok(lines.some(line => line.includes('grid=4x1x1') && line.includes('block=128x1x1')));
            const profileRelative = lines.find(line => line.startsWith('Raw profile metadata and samples: '))?.split(': ').slice(1).join(': ');
            assert.ok(profileRelative, 'The command should save profile metadata and raw event samples.');
            const profile = JSON.parse(await readFile(path.join(directory, profileRelative!), 'utf8')) as { correctness: string; rawSamples: Array<{run: number; siteId: number}>; rawCopySamples: Array<{run: number; siteId: number}>; measuredProgramRuns: number; warmupRuns: number; profileKind: string; rawProgramOutput: string[] };
            assert.strictEqual(profile.profileKind, 'existing-cuda-source');
            assert.strictEqual(profile.correctness, 'Result correctness not independently verified');
            assert.strictEqual(profile.rawSamples.length, 10);
            assert.strictEqual(profile.rawCopySamples.length, 10);
            assert.strictEqual(profile.measuredProgramRuns, 5);
            assert.strictEqual(profile.warmupRuns, 1);
            assert.deepStrictEqual([...new Set(profile.rawSamples.map(sample => sample.run))], [1, 2, 3, 4, 5]);
            assert.deepStrictEqual(profile.rawSamples.reduce((counts, sample) => counts.set(sample.siteId, (counts.get(sample.siteId) ?? 0) + 1), new Map<number, number>()), new Map([[0, 5], [1, 5]]));
            assert.deepStrictEqual(profile.rawCopySamples.reduce((counts, sample) => counts.set(sample.siteId, (counts.get(sample.siteId) ?? 0) + 1), new Map<number, number>()), new Map([[0, 5], [1, 5]]));
            assert.ok(profile.rawProgramOutput.some(line => line.startsWith('KP_PROFILE_RUN,2,2')));
        } finally {
            window.createOutputChannel = originalCreate;
            window.showWarningMessage = originalWarning;
            window.showErrorMessage = originalError;
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            await rm(directory, { recursive: true, force: true });
        }
    });

    test('distinguishes unreachable static launch sites from executed kernel samples', async function () {
        this.timeout(120000);
        try {
            await import('node:child_process').then(({ execFileSync }) => execFileSync(process.env.NVCC || 'nvcc', ['--version'], { stdio: 'ignore' }));
            await import('node:child_process').then(({ execFileSync }) => execFileSync(process.env.NVIDIA_SMI || 'nvidia-smi', ['-L'], { stdio: 'ignore' }));
        } catch { this.skip(); return; }

        const providedPath = process.env.KERNELPILOT_REPRO_CUDA_FILE;
        const directory = providedPath ? path.dirname(providedPath) : await mkdtemp(path.join(os.tmpdir(), 'kernelpilot-no-launch-'));
        const sourcePath = providedPath ?? path.join(directory, 'unused-launch.cu');
        const source = providedPath ? await readFile(sourcePath, 'utf8') : `#include <cuda_runtime.h>\n#include <cstdio>\n__global__ void firstKernel(int* p) { *p += 1; }\n__global__ void secondKernel(int* p) { *p += 1; }\nvoid unusedGpuWrapper(int* p) { firstKernel<<<1, 1>>>(p); secondKernel<<<1, 1>>>(p); }\nint main() { std::puts("Checksum: 110175874.97965786"); return 0; }`;
        if (!providedPath) {await writeFile(sourcePath, source, 'utf8');}
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
        await vscode.window.showTextDocument(document);
        const lines: string[] = [];
        let commandError = '';
        const window = vscode.window as unknown as {
            createOutputChannel: (name: string, options?: { log: boolean }) => vscode.OutputChannel;
            showWarningMessage: (...args: unknown[]) => Promise<unknown>;
            showErrorMessage: (...args: unknown[]) => Promise<unknown>;
        };
        const originalCreate = window.createOutputChannel.bind(vscode.window);
        const originalWarning = window.showWarningMessage.bind(vscode.window);
        const originalError = window.showErrorMessage.bind(vscode.window);
        window.createOutputChannel = (name, options) => {
            const channel = originalCreate(name, options);
            const append = channel.appendLine.bind(channel);
            channel.appendLine = value => {lines.push(value); append(value);};
            return channel;
        };
        window.showWarningMessage = async (...args) => {
            const message = String(args[0] ?? '');
            if (message.includes('will invoke a compiler on user/model-provided source')) {return 'Compile source';}
            if (message.startsWith('Run the existing CUDA program')) {return 'Run isolated CUDA profile';}
            return undefined;
        };
        window.showErrorMessage = async message => {commandError = String(message); return undefined;};
        try {
            await vscode.commands.executeCommand('rogowskikernelpilot.profileBottlenecks');
            assert.match(commandError, /No original CUDA kernel launch executed/);
            assert.ok(lines.some(line => line.includes('Detected launch sites: 2')));
            assert.ok(lines.some(line => line.includes('finalizer ran and recorded zero launches')));
            assert.ok(lines.some(line => line.includes('Ordinary program output (kept separate from profiler records)')));
            assert.ok(lines.some(line => line.includes('Checksum: 110175874.97965786')));
            if (providedPath) {
                assert.ok(lines.some(line => line.includes('Detected launch sites: 2 (sumOfSquaresPartialKernel, sumOfSquaresFinalKernel)')));
                assert.ok(lines.some(line => line.includes('site 0 (sumOfSquaresPartialKernel), site 1 (sumOfSquaresFinalKernel)')));
            }
            assert.ok(!lines.some(line => line.startsWith('KP_PROFILE_KERNEL,run=')));
            assert.ok(lines.some(line => line.includes('Static launch expressions (site 0 (firstKernel), site 1 (secondKernel))')) || providedPath);
        } finally {
            window.createOutputChannel = originalCreate;
            window.showWarningMessage = originalWarning;
            window.showErrorMessage = originalError;
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            if (!providedPath) {await rm(directory, { recursive: true, force: true });}
        }
    });
});
