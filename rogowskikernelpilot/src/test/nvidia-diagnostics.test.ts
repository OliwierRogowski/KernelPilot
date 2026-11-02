import * as assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkNvidiaDiagnosticsEnvironment, parseNcuCsv, parseNcuMetricNames, runNvidiaDiagnostics, sanitizerStatus, summarizeMetricEvidence, validateNvidiaDiagnosticsConfig, type NvidiaDiagnosticsConfig } from '../nvidiaDiagnostics';

const rowCsv = [
    '"ID","Process ID","Kernel Name","Metric Name","Metric Unit","Metric Value"',
    '"0","123","first kernel","sm__throughput.avg.pct_of_peak_sustained_elapsed","%","72.5"',
    '"1","123","second kernel","dram__throughput.avg.pct_of_peak_sustained_elapsed","%","N/A"',
    '"2","123","first kernel","dram__throughput.avg.pct_of_peak_sustained_elapsed","%","81.0"'
].join('\n');
const wideCsv = [
    '"ID","Process ID","Kernel Name","Kernel Time","sm__throughput.avg.pct_of_peak_sustained_elapsed","dram__throughput.avg.pct_of_peak_sustained_elapsed"',
    '"","","","","%","%"',
    '"0","123","first kernel","2026-11-02 12:00:00","70","80"',
    '"1","123","second kernel","2026-11-02 12:00:01","50","N/A"'
].join('\n');

suite('NVIDIA diagnostics report parsing and execution', () => {
    test('environment check records tool versions, driver, and query-only success without claiming a working profile', async function () {
        this.timeout(5000);
        const root = await mkdtemp(path.join(os.tmpdir(), 'kernelpilot nvidia env '));
        const ncu = path.join(root, 'ncu fake'), sanitizer = path.join(root, 'sanitizer fake'), smi = path.join(root, 'smi fake');
        const cli = (version: string) => `#!/usr/bin/env node\nconst a=process.argv.slice(2); if(a[0]==='--version') console.log(${JSON.stringify(version)}); else if(a[0]==='--help') console.log('--query-metrics --query-metrics-mode --csv'); else if(a.includes('--query-metrics')) console.log('sm__throughput.avg.pct_of_peak_sustained_elapsed'); else process.exit(2);\n`;
        await writeFile(ncu, cli('Nsight Compute 2026.3'));
        await writeFile(sanitizer, cli('Compute Sanitizer 2026.3'));
        await writeFile(smi, `#!/usr/bin/env node\nconsole.log('NVIDIA Test GPU, 555.55');\n`);
        await Promise.all([ncu, sanitizer, smi].map(file => chmod(file, 0o700)));
        try {
            const result = await checkNvidiaDiagnosticsEnvironment({ ncuPath: ncu, sanitizerPath: sanitizer, gpuQueryPath: smi, reportDirectory: path.join(root, 'reports'), timeoutMs: 1000 });
            assert.strictEqual(result.report.ncu.version, 'Nsight Compute 2026.3');
            assert.strictEqual(result.report.sanitizer.version, 'Compute Sanitizer 2026.3');
            assert.deepStrictEqual(result.report.gpu, { available: true, model: 'NVIDIA Test GPU', driverVersion: '555.55', details: 'NVIDIA Test GPU, 555.55' });
            assert.strictEqual(result.report.counters.status, 'query-only-success-not-proof');
            assert.strictEqual(result.report.counters.discoveredMetricCount, 1);
            assert.ok(result.report.limitations[0].includes('does not prove'));
            assert.ok(await readFile(result.jsonPath, 'utf8'));
            assert.ok(await readFile(result.rawPath, 'utf8'));
        } finally {await rm(root, { recursive: true, force: true });}
    });
    test('environment check distinguishes missing tools, unsupported CLI options and counter permission errors', async function () {
        this.timeout(6000);
        const root = await mkdtemp(path.join(os.tmpdir(), 'kernelpilot nvidia env errors '));
        const smi = path.join(root, 'no gpu'); await writeFile(smi, '#!/bin/sh\necho "No devices were found" >&2\nexit 1\n'); await chmod(smi, 0o700);
        const smiGpu = path.join(root, 'gpu'); await writeFile(smiGpu, '#!/bin/sh\necho "NVIDIA Test GPU, 555.55"\n'); await chmod(smiGpu, 0o700);
        const sanitizer = path.join(root, 'sanitizer'); await writeFile(sanitizer, '#!/bin/sh\necho "Compute Sanitizer 2026.3"\nexit 0\n'); await chmod(sanitizer, 0o700);
        const unsupported = path.join(root, 'unsupported ncu'); await writeFile(unsupported, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo ncu-fake; elif [ "$1" = "--help" ]; then echo "usage: ncu"; else echo "unknown option --query-metrics" >&2; exit 1; fi\n'); await chmod(unsupported, 0o700);
        const denied = path.join(root, 'denied ncu'); await writeFile(denied, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo ncu-fake; elif [ "$1" = "--help" ]; then echo "--query-metrics --query-metrics-mode --csv"; else echo "ERR_NVGPUCTRPERM" >&2; exit 1; fi\n'); await chmod(denied, 0o700);
        const changedFormat = path.join(root, 'changed format ncu'); await writeFile(changedFormat, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo ncu-fake; elif [ "$1" = "--help" ]; then echo "--query-metrics --query-metrics-mode --csv"; else echo "a future non-CSV metric layout"; fi\n'); await chmod(changedFormat, 0o700);
        const empty = path.join(root, 'empty ncu'); await writeFile(empty, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo ncu-fake; elif [ "$1" = "--help" ]; then echo "--query-metrics --query-metrics-mode --csv"; else exit 0; fi\n'); await chmod(empty, 0o700);
        try {
            const missing = await checkNvidiaDiagnosticsEnvironment({ ncuPath: path.join(root, 'absent ncu'), sanitizerPath: path.join(root, 'absent sanitizer'), gpuQueryPath: smi, reportDirectory: path.join(root, 'r1'), timeoutMs: 500 });
            assert.strictEqual(missing.report.ncu.state, 'missing'); assert.strictEqual(missing.report.counters.status, 'missing-tool');
            const unsupportedResult = await checkNvidiaDiagnosticsEnvironment({ ncuPath: unsupported, sanitizerPath: sanitizer, gpuQueryPath: smi, reportDirectory: path.join(root, 'r2'), timeoutMs: 500 });
            assert.strictEqual(unsupportedResult.report.gpu.available, false); assert.strictEqual(unsupportedResult.report.counters.status, 'unsupported-option');
            const deniedResult = await checkNvidiaDiagnosticsEnvironment({ ncuPath: denied, sanitizerPath: sanitizer, gpuQueryPath: smi, reportDirectory: path.join(root, 'r3'), timeoutMs: 500 });
            assert.strictEqual(deniedResult.report.counters.status, 'permission-denied');
            assert.ok(deniedResult.report.limitations.some(item => item.includes('permissions')));
            const changed = await checkNvidiaDiagnosticsEnvironment({ ncuPath: changedFormat, sanitizerPath: sanitizer, gpuQueryPath: smiGpu, reportDirectory: path.join(root, 'r4'), timeoutMs: 500 });
            assert.strictEqual(changed.report.counters.status, 'unknown-error', 'unrecognized successful output must not be treated as access');
            const noOutput = await checkNvidiaDiagnosticsEnvironment({ ncuPath: empty, sanitizerPath: sanitizer, gpuQueryPath: smiGpu, reportDirectory: path.join(root, 'r5'), timeoutMs: 500 });
            assert.strictEqual(noOutput.report.counters.status, 'unknown-error', 'empty output must not imply support');
        } finally {await rm(root, { recursive: true, force: true });}
    });
    test('discovers metric names from query output without treating headers as metrics', () => {
        assert.deepStrictEqual(parseNcuMetricNames('"Metric Name","Description"\nsm__throughput.avg.pct_of_peak_sustained_elapsed,SM throughput\nnot a metric\n'), ['sm__throughput.avg.pct_of_peak_sustained_elapsed']);
    });
    test('parses a saved row-per-metric CSV with per-launch kernel identity, units and missing metrics', async () => {
        const savedReport = await readFile(path.resolve(__dirname, '../../src/test/fixtures/ncu-row-per-metric.csv'), 'utf8');
        assert.deepStrictEqual(parseNcuCsv(savedReport), [
            { kernel: 'first kernel', launchId: '0', name: 'sm__throughput.avg.pct_of_peak_sustained_elapsed', value: '72.5', unit: '%' },
            { kernel: 'first kernel', launchId: '2', name: 'dram__throughput.avg.pct_of_peak_sustained_elapsed', value: '81.0', unit: '%' }
        ]);
    });
    test('parses a saved raw-page CSV with per-launch rows and unit row', async () => {
        const savedReport = await readFile(path.resolve(__dirname, '../../src/test/fixtures/ncu-raw-page-wide.csv'), 'utf8');
        assert.deepStrictEqual(parseNcuCsv(savedReport), [
            { kernel: 'first kernel', launchId: '0', name: 'sm__throughput.avg.pct_of_peak_sustained_elapsed', value: '70', unit: '%' },
            { kernel: 'first kernel', launchId: '0', name: 'dram__throughput.avg.pct_of_peak_sustained_elapsed', value: '80', unit: '%' },
            { kernel: 'second kernel', launchId: '1', name: 'sm__throughput.avg.pct_of_peak_sustained_elapsed', value: '50', unit: '%' }
        ]);
    });
    test('associates hypotheses only with multi-counter measurements from the same launch', async () => {
        const parsed = parseNcuCsv(await readFile(path.resolve(__dirname, '../../src/test/fixtures/ncu-row-per-metric.csv'), 'utf8'));
        const result = summarizeMetricEvidence([...parsed, { kernel: 'first kernel', launchId: '9', name: 'dram__throughput.avg.pct_of_peak_sustained_elapsed', value: '81', unit: '%' }]);
        assert.strictEqual(result.observations.length, 3);
        assert.strictEqual(result.hypotheses.length, 0, 'metrics from different launches must not be combined');
    });
    test('validates tool configuration', () => {
        const config: NvidiaDiagnosticsConfig = { ncuPath: 'ncu', sanitizerPath: 'compute-sanitizer', reportDirectory: '/tmp/reports', timeoutMs: 30, kernelRegex: 'smoke.*', launchCount: 2, sanitizers: ['memcheck'] };
        assert.strictEqual(validateNvidiaDiagnosticsConfig(config), config);
        assert.throws(() => validateNvidiaDiagnosticsConfig({ ...config, timeoutMs: 0 }), /timeout/);
        assert.throws(() => validateNvidiaDiagnosticsConfig({ ...config, kernelRegex: '[' }), /regular expression/);
        assert.throws(() => validateNvidiaDiagnosticsConfig({ ...config, launchCount: 0 }), /launch count/);
        assert.throws(() => validateNvidiaDiagnosticsConfig({ ...config, sanitizers: ['unknown' as never] }), /Unknown Compute/);
    });
    test('requires a conclusive zero summary for clean and preserves problem/tool-error distinctions', () => {
        assert.strictEqual(sanitizerStatus({ code: 0, stdout: '========= ERROR SUMMARY: 0 errors' , stderr: '' }), 'clean');
        assert.strictEqual(sanitizerStatus({ code: 86, stdout: '========= ERROR SUMMARY: 1 error' , stderr: '' }), 'problem');
        assert.strictEqual(sanitizerStatus({ code: 0, stdout: '', stderr: '' }), 'tool-error');
        assert.strictEqual(sanitizerStatus({ code: 1, stdout: '========= ERROR SUMMARY: 0 errors', stderr: '' }), 'tool-error');
        assert.strictEqual(sanitizerStatus({ code: null, stdout: '', stderr: 'missing', launchError: true }), 'tool-error');
        assert.strictEqual(sanitizerStatus({ code: null, stdout: 'partial', stderr: '', timedOut: true }), 'tool-error');
        assert.strictEqual(sanitizerStatus({ code: 0, stdout: '========= ERROR SUMMARY: 1 hazard', stderr: '' }), 'problem');
        assert.strictEqual(sanitizerStatus({ code: 0, stdout: '========= RACECHECK SUMMARY: 0 hazards displayed (0 errors, 0 warnings)', stderr: '' }), 'clean');
        assert.strictEqual(sanitizerStatus({ code: 0, stdout: '========= RACECHECK SUMMARY: 1 hazard displayed (0 errors, 1 warning)', stderr: '' }), 'problem');
    });
    test('passes spaced paths and special arguments literally, preserves cwd, and creates unique reports concurrently', async function () {
        this.timeout(10000);
        const root = await mkdtemp(path.join(os.tmpdir(), 'kernelpilot nvidia args '));
        const cwd = path.join(root, 'working directory'); const reportDirectory = path.join(root, 'reports');
        await import('node:fs/promises').then(fs => fs.mkdir(cwd));
        const ncuPath = path.join(root, 'fake ncu'); const sanitizerPath = path.join(root, 'fake sanitizer');
        const appPath = path.join(root, 'target app'); const received = path.join(root, 'received.json');
        await writeFile(appPath, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(received)}, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));\n`, 'utf8');
        await chmod(appPath, 0o700);
        await writeFile(ncuPath, `#!/usr/bin/env node\nconst a=process.argv.slice(2); if(a.includes('--version')) console.log('Nsight Compute Version 2026.3'); else if(a.includes('--query-metrics')) console.log('sm__throughput.avg.pct_of_peak_sustained_elapsed'); else if(a.includes('--metrics')) { console.log(${JSON.stringify(wideCsv)}); const i=a.indexOf('--export'); require('node:fs').writeFileSync(a[i+1],'raw'); }\n`, 'utf8');
        await writeFile(sanitizerPath, `#!/usr/bin/env node\nconst a=process.argv.slice(2); if(a.includes('--version')) {console.log('Compute Sanitizer 2026.3');process.exit(0)} const i=a.indexOf('--'); const r=require('node:child_process').spawnSync(a[i+1],a.slice(i+2),{cwd:process.cwd(),encoding:'utf8'}); if(r.error) {console.error(r.error.message);process.exit(2)} process.stdout.write(r.stdout||''); console.log('========= ERROR SUMMARY: 0 errors'); process.exit(r.status||0);\n`, 'utf8');
        await chmod(ncuPath, 0o700); await chmod(sanitizerPath, 0o700);
        const config: NvidiaDiagnosticsConfig = { ncuPath, sanitizerPath, reportDirectory, cwd, timeoutMs: 3000, kernelRegex: 'smoke', launchCount: 2, sanitizers: ['memcheck'] };
        const specialArgs = ['space value', 'semi;colon', 'dollar$sign', 'quote"value', 'glob[*]'];
        try {
            const appPathRelativeToCwd = path.relative(cwd, appPath);
            const results = await Promise.all([runNvidiaDiagnostics(appPathRelativeToCwd, specialArgs, config), runNvidiaDiagnostics(appPathRelativeToCwd, specialArgs, config)]);
            assert.notStrictEqual(results[0].jsonPath, results[1].jsonPath);
            assert.deepStrictEqual((JSON.parse(await readFile(received, 'utf8')) as { args: string[]; cwd: string }).args, specialArgs);
            assert.strictEqual((JSON.parse(await readFile(received, 'utf8')) as { cwd: string }).cwd, cwd);
            assert.strictEqual(results[0].report.sanitizers[0].status, 'clean');
            assert.strictEqual(results[0].report.profile.status, 'completed');
            assert.strictEqual(results[0].report.executable, appPath);
            assert.ok(results[0].report.profile.metrics.every(metric => metric.kernel && metric.launchId));
            assert.strictEqual((await readdir(reportDirectory)).filter(name => name.endsWith('.json')).length, 2);
        } finally {await rm(root, { recursive: true, force: true });}
    });
    test('times out a hanging profiler and writes a partial report', async function () {
        this.timeout(5000);
        const root = await mkdtemp(path.join(os.tmpdir(), 'kernelpilot nvidia timeout '));
        const app = path.join(root, 'app'); const slow = path.join(root, 'slow ncu');
        await writeFile(app, '#!/bin/sh\nexit 0\n'); await chmod(app, 0o700);
        const marker = path.join(root, 'child-was-not-killed');
        await writeFile(slow, `#!/bin/sh\n(sleep 0.7; echo alive > ${JSON.stringify(marker)}) &\nsleep 10\n`); await chmod(slow, 0o700);
        const reportDirectory = path.join(root, 'reports');
        try {
            const result = await runNvidiaDiagnostics(app, [], { ncuPath: slow, sanitizerPath: slow, reportDirectory, timeoutMs: 150, kernelRegex: '.*', launchCount: 1, sanitizers: [] });
            assert.strictEqual(result.report.profile.status, 'timeout');
            assert.ok(await readFile(result.jsonPath, 'utf8'));
            assert.ok(await readFile(result.rawPath, 'utf8'));
            await new Promise(resolve => setTimeout(resolve, 850));
            await assert.rejects(readFile(marker, 'utf8'));
        } finally {await rm(root, { recursive: true, force: true });}
    });
    test('cancels active processes, retains a report, and marks unstarted checks not-run', async function () {
        this.timeout(5000);
        const root = await mkdtemp(path.join(os.tmpdir(), 'kernelpilot nvidia cancel '));
        const app = path.join(root, 'app'); const slow = path.join(root, 'slow ncu'); const abort = new AbortController();
        await writeFile(app, '#!/bin/sh\nexit 0\n'); await chmod(app, 0o700);
        await writeFile(slow, '#!/bin/sh\nsleep 10\n'); await chmod(slow, 0o700);
        const reportDirectory = path.join(root, 'reports');
        const promise = runNvidiaDiagnostics(app, [], { ncuPath: slow, sanitizerPath: slow, reportDirectory, timeoutMs: 3000, kernelRegex: '.*', launchCount: 1, sanitizers: ['memcheck'], signal: abort.signal });
        setTimeout(() => abort.abort(), 100);
        try {
            const result = await promise;
            assert.strictEqual(result.report.profile.status, 'cancelled');
            assert.strictEqual(result.report.sanitizers[0].status, 'not-run');
            assert.ok(result.report.limitations.some(item => item.includes('cancelled')));
            assert.ok(await readFile(result.jsonPath, 'utf8'));
        } finally {await rm(root, { recursive: true, force: true });}
    });
    test('marks missing executable and missing tools as errors without claiming clean checks', async function () {
        this.timeout(5000);
        const root = await mkdtemp(path.join(os.tmpdir(), 'kernelpilot nvidia missing '));
        const reportDirectory = path.join(root, 'reports');
        try {
            const result = await runNvidiaDiagnostics(path.join(root, 'missing binary'), [], { ncuPath: path.join(root, 'missing ncu'), sanitizerPath: path.join(root, 'missing sanitizer'), reportDirectory, timeoutMs: 1000, kernelRegex: '.*', launchCount: 1, sanitizers: ['memcheck'] });
            assert.strictEqual(result.report.profile.status, 'tool-error');
            assert.strictEqual(result.report.sanitizers[0].status, 'tool-error');
            assert.ok(result.report.limitations.length > 0);
        } finally {await rm(root, { recursive: true, force: true });}
    });
    test('reports missing tools and no-GPU/unsupported-metric states explicitly', async function () {
        this.timeout(8000);
        const root = await mkdtemp(path.join(os.tmpdir(), 'kernelpilot nvidia unavailable '));
        const app = path.join(root, 'app'); const ncu = path.join(root, 'ncu'); const noGpuNcu = path.join(root, 'ncu no gpu');
        await writeFile(app, '#!/bin/sh\nexit 0\n'); await chmod(app, 0o700);
        await writeFile(ncu, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo ncu-fake; exit 0; fi\nif [ "$1" = "--query-metrics" ]; then echo "no metrics available"; exit 0; fi\nexit 0\n'); await chmod(ncu, 0o700);
        await writeFile(noGpuNcu, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo ncu-fake; exit 0; fi\necho "No CUDA-capable device is detected" >&2\nexit 1\n'); await chmod(noGpuNcu, 0o700);
        const reportDirectory = path.join(root, 'reports');
        try {
            const missing = await runNvidiaDiagnostics(app, [], { ncuPath: path.join(root, 'missing ncu'), sanitizerPath: path.join(root, 'missing sanitizer'), reportDirectory, timeoutMs: 1000, kernelRegex: '.*', launchCount: 1, sanitizers: ['memcheck'] });
            assert.strictEqual(missing.report.profile.status, 'tool-error');
            assert.strictEqual(missing.report.sanitizers[0].status, 'tool-error');
            const unsupported = await runNvidiaDiagnostics(app, [], { ncuPath: ncu, sanitizerPath: path.join(root, 'missing sanitizer'), reportDirectory, timeoutMs: 1000, kernelRegex: '.*', launchCount: 1, sanitizers: [] });
            assert.strictEqual(unsupported.report.profile.status, 'unsupported-metrics');
            assert.ok(unsupported.report.profile.unavailableMetrics.length > 0);
            const noGpu = await runNvidiaDiagnostics(app, [], { ncuPath: noGpuNcu, sanitizerPath: path.join(root, 'missing sanitizer'), gpuQueryPath: path.join(root, 'missing nvidia-smi'), reportDirectory, timeoutMs: 1000, kernelRegex: '.*', launchCount: 1, sanitizers: [] });
            assert.strictEqual(noGpu.report.gpu, null);
            assert.strictEqual(noGpu.report.profile.status, 'no-gpu');
            assert.ok(noGpu.report.limitations.some(value => value.includes('GPU model was not detected')));
        } finally {await rm(root, { recursive: true, force: true });}
    });
});
