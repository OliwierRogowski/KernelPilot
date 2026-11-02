import * as assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { attachCudaValidationToReport, compareKernelpilotOutputs, createValidationInput, parseKernelpilotOutput, runCudaResultValidation, validateCudaResultValidationConfig, type CudaResultValidationConfig, type ParsedKernelpilotOutput } from '../cudaResultValidation';

const execFileAsync = promisify(execFile);
function parsed(type: ParsedKernelpilotOutput['type'], ...values: string[]): ParsedKernelpilotOutput {return { type, count: values.length, values: values.map((value, index) => ({ index, value })) };}
function config(root: string, execute: CudaResultValidationConfig['execute']): CudaResultValidationConfig {
    return { referenceExecutable: 'reference', candidateExecutable: 'candidate', reportDirectory: path.join(root, 'reports'), cwd: root, timeoutMs: 1000, seed: 17, inputCount: 4, absoluteTolerance: 0.01, relativeTolerance: 0, execute };
}

suite('CUDA result validation protocol and runner', () => {
    test('creates a repeatable shared input file with the saved seed', () => {
        const first = createValidationInput(1234, 5);
        assert.strictEqual(first, createValidationInput(1234, 5));
        assert.match(first, /^KP_INPUT_V1\nseed,1234\ntype,float64\ncount,5\n/);
        assert.strictEqual(first.trim().split('\n').filter(line => line.startsWith('value,')).length, 5);
    });
    test('parses typed indexed results and rejects malformed, incomplete, duplicate and unsupported output', () => {
        assert.deepStrictEqual(parseKernelpilotOutput('ordinary log\nKP_RESULT_V1,int64,2\nKP_VALUE,1,9223372036854775807\nKP_VALUE,0,-7\n'), parsed('int64', '-7', '9223372036854775807'));
        assert.deepStrictEqual(parseKernelpilotOutput('KP_RESULT_V1,float64,2\nKP_VALUE,0,NaN\nKP_VALUE,1,+Inf\n'), parsed('float64', 'NaN', '+Inf'));
        assert.throws(() => parseKernelpilotOutput('KP_RESULT_V2,float64,0'), /exactly one/);
        assert.throws(() => parseKernelpilotOutput('KP_RESULT_V1,decimal,0'), /unsupported result type/);
        assert.throws(() => parseKernelpilotOutput('KP_RESULT_V1,float64,2\nKP_VALUE,0,1'), /provided 1/);
        assert.throws(() => parseKernelpilotOutput('KP_RESULT_V1,int32,2\nKP_VALUE,0,1\nKP_VALUE,0,1'), /duplicate/);
        assert.throws(() => parseKernelpilotOutput('KP_RESULT_V1,uint32,1\nKP_VALUE,0,-1'), /Invalid uint32/);
    });
    test('uses exact integer comparison and the documented absolute-plus-relative float boundary', () => {
        assert.strictEqual(compareKernelpilotOutputs(parsed('int64', '9007199254740993'), parsed('int64', '9007199254740992'), 99, 99).status, 'failed');
        assert.strictEqual(compareKernelpilotOutputs(parsed('float64', '100'), parsed('float64', '101'), 0, 0.01).status, 'passed');
        assert.strictEqual(compareKernelpilotOutputs(parsed('float64', '100'), parsed('float64', '101.01'), 0, 0.01).status, 'failed');
        const result = compareKernelpilotOutputs(parsed('float64', '0'), parsed('float64', '0.1'), 0, 0);
        assert.strictEqual(result.relativeErrorUnavailableCount, 1); assert.strictEqual(result.maxRelativeError, null);
    });
    test('handles NaN, signed infinities, incompatible types, length mismatches and finite error maxima', () => {
        assert.strictEqual(compareKernelpilotOutputs(parsed('float64', 'NaN', '+Inf', '-Inf'), parsed('float64', 'NaN', '+Inf', '-Inf'), 0, 0).status, 'passed');
        const special = compareKernelpilotOutputs(parsed('float64', 'NaN', '+Inf', '1'), parsed('float64', '2', '-Inf', '+Inf'), 0, 0);
        assert.strictEqual(special.status, 'failed'); assert.strictEqual(special.mismatchCount, 3); assert.strictEqual(special.firstMismatches[0].index, 0);
        const typeMismatch = compareKernelpilotOutputs(parsed('int32', '1'), parsed('float32', '1'), 0, 0);
        assert.strictEqual(typeMismatch.status, 'failed'); assert.strictEqual(typeMismatch.mismatchCount, null); assert.match(typeMismatch.reason ?? '', /Incompatible result types/);
        const length = compareKernelpilotOutputs(parsed('int32', '1'), parsed('int32', '1', '2'), 0, 0);
        assert.strictEqual(length.mismatchCount, 1); assert.deepStrictEqual(length.firstMismatches[0], { index: 1, reference: null, candidate: '2', absoluteError: null, relativeError: null, reason: 'value is missing from one output because lengths differ' });
        const errors = compareKernelpilotOutputs(parsed('float64', '1', '2'), parsed('float64', '1.25', '1.5'), 0, 0);
        assert.strictEqual(errors.maxAbsoluteError, '0.5'); assert.strictEqual(errors.maxRelativeError, 0.25);
    });
    test('validates timeouts, seeds, sizes, arguments and tolerances', () => {
        const value = config('/tmp', async () => ({ stdout: '', stderr: '', exitCode: 0 }));
        assert.doesNotThrow(() => validateCudaResultValidationConfig(value));
        assert.throws(() => validateCudaResultValidationConfig({ ...value, seed: -1 }), /seed/);
        assert.throws(() => validateCudaResultValidationConfig({ ...value, timeoutMs: 0 }), /timeout/);
        assert.throws(() => validateCudaResultValidationConfig({ ...value, inputCount: 0 }), /input count/);
        assert.throws(() => validateCudaResultValidationConfig({ ...value, absoluteTolerance: Number.NaN }), /tolerance/);
        assert.throws(() => validateCudaResultValidationConfig({ ...value, candidateArgs: [2 as never] }), /arrays of strings/);
    });
    test('runs reference and candidate with identical input and literal arguments, writes the passed report', async function () {
        this.timeout(5000);
        const root = await mkdtemp(path.join(os.tmpdir(), 'kernelpilot result compare '));
        const reference = path.join(root, 'reference'), candidate = path.join(root, 'candidate');
        await writeFile(reference, '#!/bin/sh\nexit 0\n'); await writeFile(candidate, '#!/bin/sh\nexit 0\n'); await chmod(reference, 0o700); await chmod(candidate, 0o700);
        const calls: Array<{ executable: string; args: string[]; input: string }> = [];
        const execute: CudaResultValidationConfig['execute'] = async (executable, args, options) => {
            const inputFile = args[args.indexOf('--kernelpilot-input') + 1]; const input = await readFile(path.join(options.cwd, inputFile), 'utf8');
            calls.push({ executable, args: [...args], input });
            const values = input.split(/\r?\n/).filter(line => line.startsWith('value,')).map(line => Number(line.split(',')[2]));
            const transformed = values.map(value => value * 3 + 2 + (executable === candidate ? 0 : 0));
            return { exitCode: 0, stderr: '', stdout: `KP_RESULT_V1,float64,${transformed.length}\n${transformed.map((value, index) => `KP_VALUE,${index},${value}`).join('\n')}\n` };
        };
        try {
            const result = await runCudaResultValidation({ ...config(root, execute), referenceExecutable: reference, candidateExecutable: candidate, referenceArgs: ['space value', ';literal'], candidateArgs: ['other $arg'] });
            assert.strictEqual(result.report.status, 'passed'); assert.strictEqual(result.report.optimizationAssessment.recommendAsSpeedup, false);
            assert.strictEqual(calls.length, 2); assert.strictEqual(calls[0].input, calls[1].input);
            assert.deepStrictEqual(calls[0].args.slice(0, 2), ['space value', ';literal']); assert.deepStrictEqual(calls[1].args.slice(0, 1), ['other $arg']);
            assert.ok(result.report.inputSha256); assert.ok(await readFile(result.inputPath, 'utf8')); assert.ok(await readFile(result.jsonPath, 'utf8')); assert.ok(await readFile(result.rawPath, 'utf8'));
            const attached = path.join(root, 'profile.json'); await writeFile(attached, JSON.stringify({ rawSamples: [{ milliseconds: 1 }] }));
            await attachCudaValidationToReport(attached, result.report);
            const profile = JSON.parse(await readFile(attached, 'utf8')) as { rawSamples: unknown[]; cudaResultValidation: { status: string }; optimizationGate: { recommendAsSpeedup: boolean } };
            assert.strictEqual(profile.rawSamples.length, 1); assert.strictEqual(profile.cudaResultValidation.status, 'passed'); assert.strictEqual(profile.optimizationGate.recommendAsSpeedup, false);
        } finally {await rm(root, { recursive: true, force: true });}
    });
    test('marks arithmetic errors failed and blocks speedup recommendations', async function () {
        const root = await mkdtemp(path.join(os.tmpdir(), 'kernelpilot result mismatch '));
        const referenceExe = path.join(root, 'reference'), candidateExe = path.join(root, 'candidate'); await writeFile(referenceExe, '#!/bin/sh\nexit 0\n'); await writeFile(candidateExe, '#!/bin/sh\nexit 0\n'); await chmod(referenceExe, 0o700); await chmod(candidateExe, 0o700);
        try {
            const result = await runCudaResultValidation({ ...config(root, async (executable, _args, options) => {
                const text = await readFile(path.join(options.cwd, _args[_args.indexOf('--kernelpilot-input') + 1]), 'utf8');
                const n = text.split(/\r?\n/).filter(line => line.startsWith('value,')).length;
                return { exitCode: 0, stderr: '', stdout: `KP_RESULT_V1,int32,${n}\n${Array.from({ length: n }, (_, i) => `KP_VALUE,${i},${executable === path.join(root, 'reference') ? 3 : 4}`).join('\n')}` };
            }), referenceExecutable: referenceExe, candidateExecutable: candidateExe, absoluteTolerance: 0, relativeTolerance: 0 });
            assert.strictEqual(result.report.status, 'failed'); assert.strictEqual(result.report.comparison?.mismatchCount, 4);
            assert.strictEqual(result.report.optimizationAssessment.disposition, 'incorrect'); assert.strictEqual(result.report.optimizationAssessment.recommendAsSpeedup, false);
            const attached = path.join(root, 'report.json'); await writeFile(attached, '{}'); await attachCudaValidationToReport(attached, result.report);
            assert.strictEqual((JSON.parse(await readFile(attached, 'utf8')) as { optimizationGate: { status: string } }).optimizationGate.status, 'incorrect');
        } finally {await rm(root, { recursive: true, force: true });}
    });
    test('does not label reference launch failure as a candidate correctness failure', async function () {
        const root = await mkdtemp(path.join(os.tmpdir(), 'kernelpilot reference failure ')); const exe = path.join(root, 'program');
        await writeFile(exe, '#!/bin/sh\nexit 0\n'); await chmod(exe, 0o700); let calls = 0;
        try {
            const result = await runCudaResultValidation({ ...config(root, async () => {calls++; throw Object.assign(new Error('reference failed'), { code: 17, stdout: '', stderr: 'input error' });}), referenceExecutable: exe, candidateExecutable: exe });
            assert.strictEqual(result.report.status, 'tool-error'); assert.strictEqual(result.report.executions.reference.status, 'tool-error');
            assert.strictEqual(result.report.executions.candidate.status, 'not-run'); assert.strictEqual(result.report.comparison, null); assert.strictEqual(calls, 1);
        } finally {await rm(root, { recursive: true, force: true });}
    });
    test('retains not-run on cancellation before launch and tool-error on timeout', async function () {
        const root = await mkdtemp(path.join(os.tmpdir(), 'kernelpilot result cancel ')); const exe = path.join(root, 'program');
        await writeFile(exe, '#!/bin/sh\nexit 0\n'); await chmod(exe, 0o700);
        try {
            const abort = new AbortController(); abort.abort();
            const cancelled = await runCudaResultValidation({ ...config(root, async () => {throw new Error('must not run');}), referenceExecutable: exe, candidateExecutable: exe, signal: abort.signal });
            assert.strictEqual(cancelled.report.status, 'not-run');
            const timeout = await runCudaResultValidation({ ...config(root, async () => {throw Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT', killed: true });}), referenceExecutable: exe, candidateExecutable: exe });
            assert.strictEqual(timeout.report.status, 'tool-error'); assert.match(timeout.report.executions.reference.error ?? '', /timed out/i);
        } finally {await rm(root, { recursive: true, force: true });}
    });
    test('compares the documented reference and CUDA example on a real GPU when the toolchain is available', async function () {
        this.timeout(60000);
        const repoRoot = path.resolve(__dirname, '../..');
        const exampleDir = path.join(repoRoot, 'examples', 'cuda-result-validation');
        const root = await mkdtemp(path.join(os.tmpdir(), 'kernelpilot result gpu '));
        try {
            await execFileAsync('nvidia-smi', ['-L'], { timeout: 5000 });
            await execFileAsync('g++', ['-std=c++17', '-O2', path.join(exampleDir, 'reference.cpp'), '-o', path.join(root, 'reference')], { timeout: 20000 });
            await execFileAsync('nvcc', ['-std=c++17', '-O2', '-lineinfo', path.join(exampleDir, 'cuda_transform_correct.cu'), '-o', path.join(root, 'correct')], { timeout: 60000 });
            await execFileAsync('nvcc', ['-std=c++17', '-O2', '-lineinfo', path.join(exampleDir, 'cuda_transform_buggy.cu'), '-o', path.join(root, 'buggy')], { timeout: 60000 });
        } catch {await rm(root, { recursive: true, force: true }); return this.skip();}
        const execute: CudaResultValidationConfig['execute'] = async (executable, args, options) => {
            const result = await execFileAsync(executable, args, { cwd: options.cwd, timeout: options.timeoutMs, signal: options.signal, maxBuffer: 1024 * 1024 });
            return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
        };
        try {
            const good = await runCudaResultValidation({ ...config(root, execute), referenceExecutable: path.join(root, 'reference'), candidateExecutable: path.join(root, 'correct'), reportDirectory: path.join(root, 'good-reports') });
            const bad = await runCudaResultValidation({ ...config(root, execute), referenceExecutable: path.join(root, 'reference'), candidateExecutable: path.join(root, 'buggy'), reportDirectory: path.join(root, 'bad-reports') });
            assert.strictEqual(good.report.status, 'passed'); assert.strictEqual(bad.report.status, 'failed');
        } finally {await rm(root, { recursive: true, force: true });}
    });
});
