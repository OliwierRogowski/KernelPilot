import * as assert from 'assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { compareKernelPilotReports, renderComparisonMarkdown } from '../reportComparison';

const exec = promisify(execFile);

suite('optimization report comparison', () => {
    const report = (times: number[], extras: Record<string, unknown> = {}): Record<string, unknown> => ({
        schema: 'kernelpilot-bottleneck-profile-v1', gpu: 'GPU A', inputSha256: 'abc123', elementCounts: [256],
        runParameters: { warmups: 2, samples: 7 }, timerScope: { cuda: 'kernel CUDA events' }, compileArguments: ['nvcc', '-O3'], environment: { driver: 'x', runtime: 'y' },
        rawPhaseSamples: times.map((milliseconds, sample) => ({ backend: 'CUDA', phase: 'kernel', size: 256, sample, milliseconds })),
        cudaResultValidation: { status: 'passed' }, ...extras
    });
    const compare = (left: ReturnType<typeof report>, right: ReturnType<typeof report>, threshold = 3) => compareKernelPilotReports(left, right, 'baseline.json', 'candidate.json', { practicalChangePercent: threshold, bootstrapIterations: 1500 });

    test('concludes a clear improvement only when the bootstrap interval clears the practical threshold and correctness passed', () => {
        const result = compare(report([10, 10.1, 9.9, 10.2, 9.8, 10.05, 9.95]), report([8, 8.1, 7.9, 8.2, 7.8, 8.05, 7.95]));
        assert.strictEqual(result.overallPerformance, 'improvement'); assert.strictEqual(result.recommendation.status, 'recommend');
        assert.ok(result.performance[0].speedup! > 1.2); assert.ok(result.performance[0].speedupCi95);
    });

    test('detects a supported regression', () => {
        const result = compare(report([8, 8.1, 7.9, 8.2, 7.8, 8.05]), report([10, 10.1, 9.9, 10.2, 9.8, 10.05]));
        assert.strictEqual(result.overallPerformance, 'regression'); assert.strictEqual(result.performance[0].result, 'regression');
    });

    test('large spread crossing zero effect remains inconclusive despite different medians', () => {
        const result = compare(report([7, 9, 10, 11, 13, 14, 15]), report([7, 9, 10, 11, 12, 14, 16]));
        assert.strictEqual(result.performance[0].result, 'inconclusive'); assert.strictEqual(result.recommendation.status, 'no-conclusion');
    });

    test('too few samples, zero and malformed times do not produce statistical claims', () => {
        const tooFew = compare(report([10, 11, 9]), report([8, 8.1, 7.9]));
        assert.strictEqual(tooFew.performance[0].result, 'inconclusive'); assert.strictEqual(tooFew.performance[0].speedupCi95, null);
        const zero = compare(report([0, 10, 10, 10, 10]), report([8, 8, 8, 8, 8]));
        assert.strictEqual(zero.performance[0].result, 'invalid-data'); assert.strictEqual(zero.performance[0].speedup, null);
        const malformed = compare(report([10, Number.NaN, 10, 10, 10]), report([8, 8, 8, 8, 8]));
        assert.strictEqual(malformed.performance[0].result, 'invalid-data');
    });

    test('reports material environment/input differences and missing legacy data as uncertainty', () => {
        const different = compare(report([10, 10, 10, 10, 10]), report([8, 8, 8, 8, 8], { gpu: 'GPU B', inputSha256: 'different', elementCounts: [128] }));
        assert.strictEqual(different.comparability.status, 'incomparable'); assert.strictEqual(different.overallPerformance, 'incomparable');
        assert.ok(different.comparability.findings.some(item => item.field === 'GPU model' && item.severity === 'material'));
        const legacy = compare({ summaries: [{ kernel: 'oldKernel', count: 8, median: 10, min: 9, max: 11 }] }, { summaries: [{ kernel: 'oldKernel', count: 8, median: 8, min: 7, max: 9 }] });
        assert.strictEqual(legacy.comparability.status, 'uncertain'); assert.strictEqual(legacy.performance[0].result, 'inconclusive');
        assert.strictEqual(legacy.recommendation.status, 'no-conclusion');
    });

    test('failed candidate correctness blocks recommendation and leaves performance separate', () => {
        const result = compare(report([10, 10.1, 9.9, 10.2, 9.8, 10.05]), report([8, 8.1, 7.9, 8.2, 7.8, 8.05], { cudaResultValidation: { status: 'failed' }, optimizationGate: { status: 'incorrect' } }));
        assert.strictEqual(result.overallPerformance, 'improvement'); assert.strictEqual(result.correctness.candidate, 'failed');
        assert.strictEqual(result.correctness.candidateRecommendationAllowed, false); assert.strictEqual(result.recommendation.status, 'do-not-recommend');
        const notValidated = compare(report([10, 10.1, 9.9, 10.2, 9.8, 10.05]), report([8, 8.1, 7.9, 8.2, 7.8, 8.05], { cudaResultValidation: { status: 'tool-error' } }));
        assert.strictEqual(notValidated.recommendation.status, 'no-conclusion');
        const legacySourceProfile = compare(report([10, 10.1, 9.9, 10.2, 9.8, 10.05]), { ...report([8, 8.1, 7.9, 8.2, 7.8, 8.05]), cudaResultValidation: undefined, correctness: 'Result correctness not independently verified', nvidiaDiagnostics: { report: { sanitizers: [{ tool: 'memcheck', status: 'clean' }] } } });
        assert.strictEqual(legacySourceProfile.correctness.candidate, 'not-validated'); assert.strictEqual(legacySourceProfile.recommendation.status, 'no-conclusion');
    });

    test('shows sanitizer outcomes and compares only same-unit metrics with exact kernel/launch keys', () => {
        const ncu = (value: string, unit = '%', secondUnit = 'raw') => ({ nvidiaDiagnostics: { report: { profile: { metrics: [
            { kernel: 'k', launchId: '0', name: 'sm__throughput.avg.pct_of_peak_sustained_elapsed', value, unit },
            { kernel: 'k', launchId: '0', name: 'dram__throughput.avg.pct_of_peak_sustained_elapsed', value, unit: secondUnit },
            { kernel: 'unknown', launchId: 'unknown', name: 'launch__occupancy_per_sm', value, unit: 'ratio' }
        ] }, sanitizers: [{ tool: 'memcheck', status: 'clean' }] } } });
        const result = compare(report([10, 10, 10, 10, 10], ncu('40', '%', 'bytes')), report([8, 8, 8, 8, 8], ncu('50', '%', 'sectors')));
        assert.strictEqual(result.ncu.comparable.length, 1); assert.ok(result.ncu.unavailable.some(item => item.includes('units differ')));
        assert.ok(result.ncu.unavailable.some(item => item.includes('identity is unavailable')));
        assert.strictEqual(result.sanitizers.baseline.length, 1); assert.strictEqual(result.sanitizers.candidate.length, 1);
    });

    test('exports conclusions, evidence, and uncertainty assumptions to Markdown', () => {
        const result = compare(report([10, 10.1, 9.9, 10.2, 9.8, 10.05]), report([8, 8.1, 7.9, 8.2, 7.8, 8.05]));
        const markdown = renderComparisonMarkdown(result);
        assert.ok(markdown.includes('Independent percentile bootstrap')); assert.ok(markdown.includes('Recommendation evidence'));
        assert.ok(markdown.includes('correctness-passed') === false); assert.ok(markdown.includes('Baseline correctness status: passed.'));
    });

    test('compares actual baseline and candidate CUDA event samples on GPU when the toolchain is available', async function () {
        this.timeout(120000);
        try {await exec('nvcc', ['--version'], { timeout: 5000 }); await exec('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { timeout: 5000 });}
        catch {this.skip(); return;}
        const directory = await mkdtemp(path.join(os.tmpdir(), 'kernelpilot-report-compare-gpu-'));
        try {
            const n = 65536, input = Buffer.alloc(n * 4);
            for (let i = 0; i < n; i++) {input.writeFloatLE((i % 97) * 0.125, i * 4);}
            const inputPath = path.join(directory, 'shared-input.bin'); await writeFile(inputPath, input);
            const sourcePath = path.join(directory, 'timed.cu');
            await writeFile(sourcePath, `#include <cuda_runtime.h>\n#include <cmath>\n#include <cstdio>\n#include <fstream>\n#include <vector>\n#ifndef BLOCK\n#define BLOCK 128\n#endif\n__global__ void transform(const float*x,float*y,int n){int i=blockIdx.x*blockDim.x+threadIdx.x;if(i<n)y[i]=x[i]*x[i]+2.0f;}\nint main(int argc,char**argv){if(argc!=2)return 2;const int n=${n};std::vector<float>x(n),y(n);std::ifstream in(argv[1],std::ios::binary);in.read((char*)x.data(),n*sizeof(float));if(!in)return 3;float *dx,*dy;if(cudaMalloc(&dx,n*sizeof(float))||cudaMalloc(&dy,n*sizeof(float)))return 4;if(cudaMemcpy(dx,x.data(),n*sizeof(float),cudaMemcpyHostToDevice))return 5;cudaEvent_t a,b;cudaEventCreate(&a);cudaEventCreate(&b);int launches=(n+BLOCK-1)/BLOCK;transform<<<launches,BLOCK>>>(dx,dy,n);if(cudaDeviceSynchronize())return 6;for(int s=0;s<7;s++){cudaEventRecord(a);for(int r=0;r<12;r++)transform<<<launches,BLOCK>>>(dx,dy,n);cudaEventRecord(b);cudaEventSynchronize(b);float ms=0;cudaEventElapsedTime(&ms,a,b);std::printf("SAMPLE,%0.9f\\n",ms/12.0f);}if(cudaMemcpy(y.data(),dy,n*sizeof(float),cudaMemcpyDeviceToHost))return 7;for(int i=0;i<n;i++){float expected=x[i]*x[i]+2.0f;if(std::fabs(y[i]-expected)>1e-6f)return 8;}std::puts("CORRECT,PASS");cudaEventDestroy(a);cudaEventDestroy(b);cudaFree(dx);cudaFree(dy);return 0;}\n`);
            const gpu = (await exec('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { timeout: 5000 })).stdout.trim().split(/\r?\n/)[0];
            const compilerVersion = (await exec('nvcc', ['--version'], { timeout: 5000 })).stdout.trim().split(/\r?\n/).at(-1) ?? 'unknown';
            const createReport = async (block: number, label: string) => {
                const executable = path.join(directory, label); const flags = ['-O3', `-DBLOCK=${block}`, sourcePath, '-o', executable];
                await exec('nvcc', flags, { timeout: 60000, maxBuffer: 1024 * 1024 });
                const run = (await exec(executable, [inputPath], { timeout: 30000 })).stdout;
                assert.ok(run.includes('CORRECT,PASS'), `${label} failed its CPU-reference correctness check`);
                const samples = [...run.matchAll(/^SAMPLE,([\d.eE+-]+)$/gm)].map(match => Number(match[1])); assert.strictEqual(samples.length, 7);
                return { schema: 'kernelpilot-bottleneck-profile-v1', gpu, compiler: 'nvcc', compilerVersion, architecture: (await exec('nvidia-smi', ['--query-gpu=compute_cap', '--format=csv,noheader'], { timeout: 5000 })).stdout.trim(),
                    inputSha256: (await import('node:crypto')).createHash('sha256').update(input).digest('hex'), elementCounts: [n], runParameters: { size: n, launchesPerSample: 12, sampleCount: 7 }, timerScope: { cuda: 'CUDA event pairs around 12 kernel launches; report is per-launch median' },
                    compilerFlags: flags, cudaResultValidation: { status: 'passed' }, rawPhaseSamples: samples.map((milliseconds, sample) => ({ backend: 'CUDA', phase: 'kernel', size: n, sample, milliseconds })) };
            };
            const baseline = await createReport(128, 'baseline'), candidate = await createReport(256, 'candidate');
            const result = compareKernelPilotReports(baseline, candidate, 'actual GPU baseline', 'actual GPU candidate', { practicalChangePercent: 3 });
            assert.strictEqual(result.performance.length, 1); assert.ok(result.performance[0].baseline.samplesMs.length === 7);
            console.log(`ACTUAL_GPU_REPORT_COMPARISON ${JSON.stringify({ gpu, baselineMedianMs: result.performance[0].baseline.medianMs, candidateMedianMs: result.performance[0].candidate.medianMs, speedup: result.performance[0].speedup, interval: result.performance[0].speedupCi95, result: result.overallPerformance })}`);
        } finally {await rm(directory, { recursive: true, force: true });}
    });
});
