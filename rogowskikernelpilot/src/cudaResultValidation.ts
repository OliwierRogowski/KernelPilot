import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, stat, writeFile, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';

export type ValidationScalarType = 'int32' | 'uint32' | 'int64' | 'uint64' | 'float32' | 'float64';
export type ValidationStatus = 'passed' | 'failed' | 'not-run' | 'tool-error';
export interface NumericValue { index: number; value: string; }
export interface ParsedKernelpilotOutput { type: ValidationScalarType; count: number; values: NumericValue[]; }
export interface ValidationMismatch { index: number; reference: string | null; candidate: string | null; absoluteError: string | null; relativeError: number | null; reason: string; }
export interface ComparisonResult {
    status: 'passed' | 'failed'; mismatchCount: number | null; comparedCount: number; incompatibleOutputCount: number;
    firstMismatches: ValidationMismatch[]; maxAbsoluteError: string | null; maxRelativeError: number | null;
    relativeErrorUnavailableCount: number; reason?: string;
}
export interface ProgramExecution { status: 'completed' | 'not-run' | 'tool-error'; exitCode: number | null; stdout: string; stderr: string; error?: string; }
export interface CudaResultValidationReport {
    schemaVersion: 1; createdAt: string; status: ValidationStatus; seed: number; inputCount: number; inputPath: string | null;
    inputSha256: string | null; inputContract: 'kernelpilot.cuda-result-validation-input/v1'; outputContract: 'kernelpilot.cuda-result-validation-output/v1';
    referenceExecutable: string; candidateExecutable: string; referenceArgs: string[]; candidateArgs: string[]; cwd: string;
    timeoutMs: number; tolerance: { absolute: number; relative: number; rule: string };
    executions: { reference: ProgramExecution; candidate: ProgramExecution };
    comparison: ComparisonResult | null;
    optimizationAssessment: { disposition: 'incorrect' | 'correctness-passed-performance-unverified' | 'unvalidated'; recommendAsSpeedup: false; reason: string };
}
export interface CudaResultValidationConfig {
    referenceExecutable: string; candidateExecutable: string; referenceArgs?: string[]; candidateArgs?: string[];
    reportDirectory: string; cwd: string; timeoutMs: number; seed: number; inputCount: number;
    absoluteTolerance: number; relativeTolerance: number; signal?: AbortSignal; maxExamples?: number;
    referenceDisplayPath?: string; candidateDisplayPath?: string;
    execute: (executable: string, args: string[], options: { cwd: string; timeoutMs: number; signal?: AbortSignal }) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

const TYPES = new Set<ValidationScalarType>(['int32', 'uint32', 'int64', 'uint64', 'float32', 'float64']);
const OUTPUT_HEADER = 'KP_RESULT_V1';

export function validateCudaResultValidationConfig(config: CudaResultValidationConfig): void {
    if (!config.referenceExecutable.trim() || !config.candidateExecutable.trim() || !config.reportDirectory.trim() || !config.cwd.trim()) {throw new Error('Executable and directory paths must not be empty.');}
    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 3600000) {throw new Error('Validation timeout must be an integer from 1 to 3600000 ms.');}
    if (!Number.isSafeInteger(config.seed) || config.seed < 0 || config.seed > 0xffffffff) {throw new Error('Validation seed must be an integer from 0 to 4294967295.');}
    if (!Number.isInteger(config.inputCount) || config.inputCount < 1 || config.inputCount > 1000000) {throw new Error('Validation input count must be an integer from 1 to 1000000.');}
    for (const [name, value] of [['absolute', config.absoluteTolerance], ['relative', config.relativeTolerance]] as const) {
        if (!Number.isFinite(value) || value < 0 || value > 1e6) {throw new Error(`${name} tolerance must be a finite number from 0 to 1000000.`);}
    }
    for (const args of [config.referenceArgs ?? [], config.candidateArgs ?? []]) {if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {throw new Error('Program arguments must be arrays of strings.');}}
}

/** SplitMix32 is fixed here so a seed generates the same shared input artifact in every run. */
export function createValidationInput(seed: number, count: number): string {
    let state = seed >>> 0;
    const values: number[] = [];
    for (let index = 0; index < count; index++) {
        state = (state + 0x9e3779b9) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 16), 0x21f0aaad) >>> 0;
        value = Math.imul(value ^ (value >>> 15), 0x735a2d97) >>> 0;
        value = (value ^ (value >>> 15)) >>> 0;
        values.push((value / 0xffffffff) * 2 - 1);
    }
    return [
        'KP_INPUT_V1', `seed,${seed}`, 'type,float64', `count,${count}`,
        ...values.map((value, index) => `value,${index},${value}`), ''
    ].join('\n');
}

export function parseKernelpilotOutput(output: string): ParsedKernelpilotOutput {
    const headers = output.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith(`${OUTPUT_HEADER},`));
    if (headers.length !== 1) {throw new Error(`Expected exactly one ${OUTPUT_HEADER} header; got ${headers.length}.`);}
    const header = headers[0].split(',');
    if (header.length !== 3 || !TYPES.has(header[1] as ValidationScalarType) || !/^\d+$/.test(header[2])) {throw new Error('Malformed result header or unsupported result type.');}
    const type = header[1] as ValidationScalarType, count = Number(header[2]);
    if (!Number.isSafeInteger(count) || count < 0 || count > 1000000) {throw new Error('Result count is outside the supported range.');}
    const values: NumericValue[] = [], seen = new Set<number>();
    for (const line of output.split(/\r?\n/).map(item => item.trim()).filter(item => item.startsWith('KP_VALUE,'))) {
        const fields = line.split(',');
        if (fields.length !== 3 || !/^\d+$/.test(fields[1]) || !fields[2]) {throw new Error(`Malformed output value record: ${line}`);}
        const index = Number(fields[1]);
        if (!Number.isSafeInteger(index) || index >= count || seen.has(index)) {throw new Error(`Invalid or duplicate output index: ${fields[1]}`);}
        validateScalar(fields[2], type);
        seen.add(index); values.push({ index, value: fields[2] });
    }
    if (values.length !== count || seen.size !== count) {throw new Error(`Output declared ${count} values but provided ${values.length}.`);}
    values.sort((left, right) => left.index - right.index);
    return { type, count, values };
}

function validateScalar(value: string, type: ValidationScalarType): void {
    if (type.startsWith('float')) {
        if (['NaN', '+Inf', '-Inf'].includes(value)) {return;}
        if (value.trim() && Number.isFinite(Number(value))) {return;}
        throw new Error(`Invalid ${type} result: ${value}`);
    }
    if (!/^-?\d+$/.test(value) || (type.startsWith('u') && value.startsWith('-'))) {throw new Error(`Invalid ${type} result: ${value}`);}
    const numeric = BigInt(value);
    const ranges: Record<ValidationScalarType, [bigint, bigint]> = {
        int32: [-2147483648n, 2147483647n], uint32: [0n, 4294967295n],
        int64: [-9223372036854775808n, 9223372036854775807n], uint64: [0n, 18446744073709551615n],
        float32: [0n, 0n], float64: [0n, 0n]
    };
    if (numeric < ranges[type][0] || numeric > ranges[type][1]) {throw new Error(`${value} is outside ${type} range.`);}
}

export function compareKernelpilotOutputs(reference: ParsedKernelpilotOutput, candidate: ParsedKernelpilotOutput, absoluteTolerance: number, relativeTolerance: number, maxExamples = 10): ComparisonResult {
    const firstMismatches: ValidationMismatch[] = [];
    if (reference.type !== candidate.type) {
        return { status: 'failed', mismatchCount: null, comparedCount: 0, incompatibleOutputCount: Math.max(reference.count, candidate.count), firstMismatches: [], maxAbsoluteError: null, maxRelativeError: null, relativeErrorUnavailableCount: 0, reason: `Incompatible result types: reference=${reference.type}, candidate=${candidate.type}.` };
    }
    const common = Math.min(reference.count, candidate.count);
    let mismatchCount = Math.abs(reference.count - candidate.count), maxAbs = 0, maxAbsString: string | null = null, maxRel: number | null = null, relativeErrorUnavailableCount = 0;
    for (let i = 0; i < common; i++) {
        const expected = reference.values[i].value, actual = candidate.values[i].value;
        let equal = false, absoluteError: string | null = null, relativeError: number | null = null, reason = 'value differs';
        if (reference.type.startsWith('float')) {
            const left = Number(expected), right = Number(actual);
            const leftNaN = expected === 'NaN', rightNaN = actual === 'NaN';
            const leftInf = expected === '+Inf' || expected === '-Inf', rightInf = actual === '+Inf' || actual === '-Inf';
            if (leftNaN || rightNaN) {equal = leftNaN && rightNaN; reason = 'NaN values compare equal only when both outputs are NaN';}
            else if (leftInf || rightInf) {equal = expected === actual; reason = 'infinity values must have the same sign';}
            else {
                const difference = Math.abs(left - right);
                const allowed = absoluteTolerance + relativeTolerance * Math.abs(left);
                equal = difference <= allowed;
                absoluteError = difference.toString();
                if (left !== 0) {relativeError = difference / Math.abs(left);}
                else if (difference === 0) {relativeError = 0;}
                else {relativeErrorUnavailableCount++;}
                if (difference > maxAbs) {maxAbs = difference; maxAbsString = difference.toString();}
                if (relativeError !== null && Number.isFinite(relativeError) && (maxRel === null || relativeError > maxRel)) {maxRel = relativeError;}
                reason = `absolute error ${difference} exceeds allowed ${allowed}`;
            }
        } else {
            const difference = (BigInt(expected) - BigInt(actual));
            const absolute = difference < 0n ? -difference : difference;
            equal = absolute === 0n;
            absoluteError = absolute.toString();
            if (absolute > BigInt(maxAbsString ?? '0')) {maxAbsString = absolute.toString();}
            const denominator = BigInt(expected) < 0n ? -BigInt(expected) : BigInt(expected);
            if (denominator) {
                const relative = Number(absolute) / Number(denominator);
                if (Number.isFinite(relative) && (maxRel === null || relative > maxRel)) {maxRel = relative;}
                relativeError = Number.isFinite(relative) ? relative : null;
            } else if (absolute === 0n) {relativeError = 0;} else {relativeErrorUnavailableCount++;}
            reason = 'integer outputs require exact equality';
        }
        if (!equal) {
            mismatchCount++;
            if (firstMismatches.length < maxExamples) {firstMismatches.push({ index: i, reference: expected, candidate: actual, absoluteError, relativeError, reason });}
        }
    }
    if (reference.count !== candidate.count) {
        for (let index = common; index < Math.max(reference.count, candidate.count) && firstMismatches.length < maxExamples; index++) {
            firstMismatches.push({ index, reference: reference.values[index]?.value ?? null, candidate: candidate.values[index]?.value ?? null, absoluteError: null, relativeError: null, reason: 'value is missing from one output because lengths differ' });
        }
    }
    return { status: mismatchCount ? 'failed' : 'passed', mismatchCount, comparedCount: common, incompatibleOutputCount: Math.abs(reference.count - candidate.count), firstMismatches, maxAbsoluteError: maxAbsString, maxRelativeError: maxRel, relativeErrorUnavailableCount, ...(reference.count === candidate.count ? {} : { reason: `Output lengths differ: reference=${reference.count}, candidate=${candidate.count}.` }) };
}

export async function runCudaResultValidation(config: CudaResultValidationConfig): Promise<{ report: CudaResultValidationReport; jsonPath: string; rawPath: string; inputPath: string }> {
    validateCudaResultValidationConfig(config);
    const cwd = path.resolve(config.cwd), reportDirectory = path.resolve(cwd, config.reportDirectory);
    await mkdir(reportDirectory, { recursive: true });
    const base = path.join(reportDirectory, `cuda-result-validation-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
    const inputPath = `${base}.input.txt`, jsonPath = `${base}.json`, rawPath = `${base}.txt`;
    const report: CudaResultValidationReport = {
        schemaVersion: 1, createdAt: new Date().toISOString(), status: 'not-run', seed: config.seed, inputCount: config.inputCount,
        inputPath: null, inputSha256: null, inputContract: 'kernelpilot.cuda-result-validation-input/v1', outputContract: 'kernelpilot.cuda-result-validation-output/v1',
        referenceExecutable: config.referenceDisplayPath ?? path.resolve(cwd, config.referenceExecutable), candidateExecutable: config.candidateDisplayPath ?? path.resolve(cwd, config.candidateExecutable),
        referenceArgs: [...(config.referenceArgs ?? [])], candidateArgs: [...(config.candidateArgs ?? [])], cwd, timeoutMs: config.timeoutMs,
        tolerance: { absolute: config.absoluteTolerance, relative: config.relativeTolerance, rule: '|candidate-reference| <= absolute + relative * |reference|; integer outputs require exact equality.' },
        executions: { reference: { status: 'not-run', exitCode: null, stdout: '', stderr: '' }, candidate: { status: 'not-run', exitCode: null, stdout: '', stderr: '' } }, comparison: null,
        optimizationAssessment: { disposition: 'unvalidated', recommendAsSpeedup: false, reason: 'No correctness comparison completed.' }
    };
    const referenceExecutable = path.resolve(cwd, config.referenceExecutable), candidateExecutable = path.resolve(cwd, config.candidateExecutable);
    const executionInputPath = path.join(cwd, `.kernelpilot-validation-${randomUUID()}.input`);
    try {
        for (const executable of [referenceExecutable, candidateExecutable]) {
            const info = await stat(executable);
            if (!info.isFile()) {throw new Error(`Validation executable is not a regular file: ${executable}`);}
            if (process.platform !== 'win32') {await access(executable, constants.X_OK);}
        }
        if (config.signal?.aborted) {report.status = 'not-run'; report.optimizationAssessment.reason = 'Cancelled before either program started.';}
        else {
            const inputContent = createValidationInput(config.seed, config.inputCount);
            const { createHash } = await import('node:crypto');
            report.inputSha256 = createHash('sha256').update(inputContent).digest('hex');
            await writeFile(executionInputPath, inputContent, { encoding: 'utf8', mode: 0o600 }); report.inputPath = inputPath;
            const execute = async (executable: string, args: string[]): Promise<ProgramExecution> => {
                if (config.signal?.aborted) {return { status: 'not-run', exitCode: null, stdout: '', stderr: '', error: 'Cancelled before launch.' };}
                try {
                    const result = await config.execute(executable, [...args, '--kernelpilot-input', path.basename(executionInputPath)], { cwd, timeoutMs: config.timeoutMs, signal: config.signal });
                    return result.exitCode === 0 ? { status: 'completed', exitCode: 0, stdout: result.stdout, stderr: result.stderr } : { status: 'tool-error', exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, error: 'Program exited with a non-zero status.' };
                } catch (error) {
                    const info = error as { stdout?: unknown; stderr?: unknown; code?: unknown; killed?: unknown; message?: unknown };
                    const timedOut = info.killed === true || info.code === 'ETIMEDOUT';
                    return { status: config.signal?.aborted ? 'not-run' : 'tool-error', exitCode: typeof info.code === 'number' ? info.code : null, stdout: typeof info.stdout === 'string' ? info.stdout : '', stderr: typeof info.stderr === 'string' ? info.stderr : '', error: `${timedOut ? 'Program timed out' : config.signal?.aborted ? 'Cancelled' : 'Program could not complete'}: ${String(info.message ?? error)}` };
                }
            };
            report.executions.reference = await execute(referenceExecutable, report.referenceArgs);
            if (report.executions.reference.status !== 'completed') {
                report.status = report.executions.reference.status === 'not-run' ? 'not-run' : 'tool-error';
                report.executions.candidate = { status: 'not-run', exitCode: null, stdout: '', stderr: '', error: 'Skipped because the reference program did not complete successfully.' };
                report.optimizationAssessment.reason = 'Reference execution failed or was cancelled; candidate correctness was not judged.';
            } else {
                report.executions.candidate = await execute(candidateExecutable, report.candidateArgs);
                if (report.executions.candidate.status !== 'completed') {
                    report.status = report.executions.candidate.status === 'not-run' ? 'not-run' : 'tool-error';
                    report.optimizationAssessment.reason = 'Candidate execution failed or was cancelled; no correctness comparison was made.';
                } else {
                    try {
                        const reference = parseKernelpilotOutput(report.executions.reference.stdout), candidate = parseKernelpilotOutput(report.executions.candidate.stdout);
                        report.comparison = compareKernelpilotOutputs(reference, candidate, config.absoluteTolerance, config.relativeTolerance, config.maxExamples);
                        report.status = report.comparison.status;
                        report.optimizationAssessment = report.status === 'failed'
                            ? { disposition: 'incorrect', recommendAsSpeedup: false, reason: 'Candidate output differs from the reference or has incompatible output shape/type.' }
                            : { disposition: 'correctness-passed-performance-unverified', recommendAsSpeedup: false, reason: 'Correctness passed; no performance claim is made without separate benchmark evidence.' };
                    } catch (error) {
                        report.status = 'tool-error'; report.optimizationAssessment.reason = `Output contract could not be parsed: ${error instanceof Error ? error.message : String(error)}`;
                    }
                }
            }
        }
    } catch (error) {
        report.status = 'tool-error'; report.optimizationAssessment.reason = error instanceof Error ? error.message : String(error);
        report.executions.reference.error ??= report.optimizationAssessment.reason;
    } finally {
        if (report.inputPath) {await writeFile(inputPath, createValidationInput(config.seed, config.inputCount), { encoding: 'utf8', mode: 0o600 });}
        try {await unlink(executionInputPath);} catch { /* No input is created for setup failure/cancellation. */}
        const raw = [
            `Status: ${report.status}`, `Seed: ${report.seed}`, `Input count: ${report.inputCount}`, `Input: ${report.inputPath ?? 'not created'}`,
            `Reference: ${report.referenceExecutable} (exit ${report.executions.reference.exitCode ?? 'not run'}; ${report.executions.reference.status})`, report.executions.reference.error ?? '', report.executions.reference.stdout, report.executions.reference.stderr,
            `Candidate: ${report.candidateExecutable} (exit ${report.executions.candidate.exitCode ?? 'not run'}; ${report.executions.candidate.status})`, report.executions.candidate.error ?? '', report.executions.candidate.stdout, report.executions.candidate.stderr,
            report.comparison ? `Comparison: ${JSON.stringify(report.comparison, null, 2)}` : 'Comparison: not available.',
            `Optimization assessment: ${report.optimizationAssessment.disposition}; speedup recommendation allowed=${report.optimizationAssessment.recommendAsSpeedup}`
        ].filter(Boolean).join('\n\n');
        await writeFile(jsonPath, JSON.stringify(report, null, 2), { encoding: 'utf8', mode: 0o600 });
        await writeFile(rawPath, raw, { encoding: 'utf8', mode: 0o600 });
    }
    return { report, jsonPath, rawPath, inputPath };
}

export async function attachCudaValidationToReport(reportPath: string, validation: CudaResultValidationReport): Promise<void> {
    const existing = JSON.parse(await readFile(reportPath, 'utf8')) as Record<string, unknown>;
    if (!existing || Array.isArray(existing) || typeof existing !== 'object') {throw new Error('Selected report must contain a JSON object.');}
    existing.cudaResultValidation = validation;
    existing.optimizationGate = {
        status: validation.status === 'failed' ? 'incorrect' : validation.status === 'passed' ? 'correctness-passed-performance-unverified' : 'unvalidated',
        recommendAsSpeedup: false,
        reason: validation.optimizationAssessment.reason
    };
    const file = `${JSON.stringify(existing, null, 2)}\n`;
    const temp = `${reportPath}.${randomUUID()}.tmp`;
    await writeFile(temp, file, { encoding: 'utf8', mode: 0o600 });
    await import('node:fs/promises').then(fs => fs.rename(temp, reportPath));
}
