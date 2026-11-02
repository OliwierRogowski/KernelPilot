import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';

export type SanitizerTool = 'memcheck' | 'racecheck' | 'initcheck' | 'synccheck';
export interface NvidiaDiagnosticsConfig {
    ncuPath: string; sanitizerPath: string; reportDirectory: string; timeoutMs: number;
    kernelRegex: string; launchCount: number; metrics?: string[]; sanitizers: SanitizerTool[];
    cwd?: string; signal?: AbortSignal;
    gpuQueryPath?: string;
}
export interface Metric { kernel: string; launchId: string; name: string; value: string; unit?: string; }
export interface SanitizerResult { tool: SanitizerTool; status: 'clean' | 'problem' | 'not-run' | 'tool-error'; exitCode: number | null; output: string; cancelled?: boolean; }
export interface NvidiaDiagnosticReport {
    schemaVersion: 1; createdAt: string; executable: string; args: string[]; cwd: string; gpu: string | null;
    ncuVersion: string | null; sanitizerVersion: string | null;
    profile: { status: string; requestedMetrics: string[]; unavailableMetrics: string[]; metrics: Metric[]; reportPath: string | null; output: string; exitCode: number | null };
    sanitizers: SanitizerResult[]; observations: string[]; hypotheses: string[]; limitations: string[];
}
const CANDIDATE_METRICS = [
    'sm__throughput.avg.pct_of_peak_sustained_elapsed', 'dram__throughput.avg.pct_of_peak_sustained_elapsed',
    'gpu__compute_memory_throughput.avg.pct_of_peak_sustained_elapsed', 'sm__warps_active.avg.pct_of_peak_sustained_active',
    'launch__occupancy_per_sm', 'smsp__sass_average_data_bytes_per_sector_mem_global_op_ld.pct',
    'smsp__sass_average_data_bytes_per_sector_mem_global_op_st.pct', 'smsp__warp_issue_stalled_long_scoreboard_per_warp_active.pct',
    'smsp__warp_issue_stalled_math_pipe_throttle_per_warp_active.pct', 'smsp__warp_issue_stalled_not_selected_per_warp_active.pct'
];

export function validateNvidiaDiagnosticsConfig(config: NvidiaDiagnosticsConfig): NvidiaDiagnosticsConfig {
    if (!config.ncuPath.trim() || !config.sanitizerPath.trim() || !config.reportDirectory.trim()) {throw new Error('NVIDIA tool paths and report directory must not be empty.');}
    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 3600000) {throw new Error('NVIDIA tool timeout must be an integer from 1 to 3600000 ms.');}
    if (!Number.isInteger(config.launchCount) || config.launchCount < 1 || config.launchCount > 10000) {throw new Error('Nsight Compute launch count must be an integer from 1 to 10000.');}
    try {if (config.kernelRegex) {new RegExp(config.kernelRegex);}} catch {throw new Error('Kernel name filter must be a valid regular expression.');}
    const allowed = new Set<SanitizerTool>(['memcheck', 'racecheck', 'initcheck', 'synccheck']);
    if (config.sanitizers.some(tool => !allowed.has(tool))) {throw new Error('Unknown Compute Sanitizer tool selected.');}
    if (config.metrics?.some(metric => !/^[a-zA-Z0-9_.*:+-]+(?:\.[a-zA-Z0-9_.*:+-]+)*$/.test(metric))) {throw new Error('Invalid Nsight Compute metric name.');}
    return config;
}

function parseCsvLine(line: string): string[] {
    const cells: string[] = []; let cell = ''; let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"' && quoted && line[i + 1] === '"') {cell += '"'; i++;}
        else if (char === '"') {quoted = !quoted;}
        else if (char === ',' && !quoted) {cells.push(cell); cell = '';}
        else {cell += char;}
    }
    cells.push(cell);
    return cells.map(value => value.trim());
}
function cleanHeader(value: string): string {return value.replace(/^\uFEFF/, '').replace(/^"|"$/g, '').trim().toLowerCase().replace(/\s+/g, ' ');}
export function parseNcuMetricNames(output: string): string[] {
    const names = new Set<string>();
    for (const line of output.split(/\r?\n/)) {
        const candidate = parseCsvLine(line)[0]?.replace(/^"|"$/g, '').trim();
        if (/^[a-z][a-z0-9_]+(?:\.[a-z0-9_]+)+$/i.test(candidate ?? '')) {names.add(candidate!);}
    }
    return [...names];
}
/** Parse ncu --csv --page raw tables and the older row-per-metric CSV layout. */
export function parseNcuCsv(output: string): Metric[] {
    const rows = output.split(/\r?\n/).filter(line => line.trim()).map(parseCsvLine);
    const metrics: Metric[] = [];
    for (let i = 0; i < rows.length; i++) {
        const header = rows[i].map(cleanHeader);
        const metricNameIndex = header.findIndex(cell => cell === 'metric name');
        const metricValueIndex = header.findIndex(cell => cell === 'metric value');
        const kernelIndex = header.findIndex(cell => cell === 'kernel name');
        const idIndex = header.findIndex(cell => cell === 'id');
        const unitIndex = header.findIndex(cell => cell === 'metric unit');
        if (metricNameIndex >= 0 && metricValueIndex >= 0) {
            for (const row of rows.slice(i + 1)) {
                const name = row[metricNameIndex] ?? '', value = row[metricValueIndex] ?? '';
                if (!/^[a-z][a-z0-9_]+(?:\.[a-z0-9_]+)+$/i.test(name) || !value || /^n\/a$/i.test(value)) {continue;}
                metrics.push({ kernel: row[kernelIndex] || 'unknown', launchId: row[idIndex] || 'unknown', name, value, ...(unitIndex >= 0 && row[unitIndex] ? { unit: row[unitIndex] } : {}) });
            }
            break;
        }
        // Nsight's raw page CSV is wide: metadata columns, metric columns, units row, then one row per launch.
        const kernelNameIndex = header.findIndex(cell => cell === 'kernel name');
        const timeIndex = header.findIndex(cell => cell === 'kernel time');
        if (kernelNameIndex >= 0 && header.some(cell => /^[a-z][a-z0-9_]+(?:\.[a-z0-9_]+)+$/i.test(cell))) {
            const metricColumns = header.map((name, index) => ({ name, index })).filter(item => /^[a-z][a-z0-9_]+(?:\.[a-z0-9_]+)+$/i.test(item.name));
            const units = rows[i + 1] ?? [];
            for (const row of rows.slice(i + 2)) {
                const kernel = row[kernelNameIndex] ?? '';
                if (!kernel) {continue;}
                const launchId = row[idIndex] || row[timeIndex] || 'unknown';
                for (const column of metricColumns) {
                    const value = row[column.index] ?? '';
                    if (value && !/^n\/a$/i.test(value)) {metrics.push({ kernel, launchId, name: column.name, value, ...(units[column.index] ? { unit: units[column.index] } : {}) });}
                }
            }
            break;
        }
    }
    return metrics;
}
export function summarizeMetricEvidence(metrics: Metric[]): { observations: string[]; hypotheses: string[] } {
    const observations = metrics.map(metric => `launch ${metric.launchId} kernel ${metric.kernel}: ${metric.name}=${metric.value}${metric.unit ? ` ${metric.unit}` : ''}`);
    const hypotheses: string[] = [];
    const perLaunch = new Map<string, Metric[]>();
    for (const metric of metrics) {const key = `${metric.launchId}\0${metric.kernel}`; perLaunch.set(key, [...(perLaunch.get(key) ?? []), metric]);}
    for (const values of perLaunch.values()) {
        const lookup = (pattern: RegExp) => values.find(metric => pattern.test(metric.name));
        const dram = lookup(/dram__throughput.*pct_of_peak/i), sm = lookup(/sm__throughput.*pct_of_peak/i), stalls = lookup(/long_scoreboard/i);
        if (dram && sm) {hypotheses.push(`Kernel ${dram.kernel}, launch ${dram.launchId}: memory-vs-compute pressure is a hypothesis only (DRAM ${dram.value}${dram.unit ?? ''}; SM ${sm.value}${sm.unit ?? ''}); validate with workload scaling and more measurements.`);}
        if (stalls) {hypotheses.push(`Kernel ${stalls.kernel}, launch ${stalls.launchId}: long-scoreboard stalls measured at ${stalls.value}${stalls.unit ?? ''}; this can indicate dependency or memory latency, but does not identify a bottleneck alone.`);}
    }
    return { observations, hypotheses };
}

export interface ProcessResult { code: number | null; stdout: string; stderr: string; launchError?: boolean; timedOut?: boolean; cancelled?: boolean; signal?: string | null; }
function run(file: string, args: string[], timeout: number, cwd: string, signal?: AbortSignal): Promise<ProcessResult> {
    return new Promise(resolve => {
        if (signal?.aborted) {resolve({ code: null, stdout: '', stderr: 'Cancelled before process launch.', cancelled: true }); return;}
        let child;
        try {child = spawn(file, args, { cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });}
        catch (error) {resolve({ code: null, stdout: '', stderr: String(error), launchError: true }); return;}
        let stdout = '', stderr = '', timedOut = false;
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => {stdout += chunk;}); child.stderr.on('data', chunk => {stderr += chunk;});
        const killTree = () => {
            try {
                if (process.platform !== 'win32' && child.pid) {process.kill(-child.pid, 'SIGKILL');}
                else if (child.pid) {spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });}
                else {child.kill('SIGKILL');}
            } catch { /* Process may already have exited. */ }
        };
        const onAbort = () => killTree();
        signal?.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => {timedOut = true; killTree();}, timeout);
        child.once('error', error => {clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve({ code: null, stdout, stderr: `${stderr}${error.message}`, launchError: true, cancelled: signal?.aborted });});
        child.once('close', (code, closeSignal) => {clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve({ code, stdout, stderr, timedOut, cancelled: signal?.aborted, signal: closeSignal });});
    });
}

export type EnvironmentState = 'available' | 'missing' | 'error';
export type CounterAccessState = 'query-only-success-not-proof' | 'permission-denied' | 'no-gpu' | 'missing-tool' | 'unsupported-option' | 'unknown-error';
export interface NvidiaEnvironmentReport {
    schemaVersion: 1; createdAt: string; ncu: { state: EnvironmentState; version: string | null; details: string };
    sanitizer: { state: EnvironmentState; version: string | null; details: string };
    gpu: { available: boolean | null; model: string | null; driverVersion: string | null; details: string };
    counters: { status: CounterAccessState; operation: string | null; discoveredMetricCount: number | null; details: string };
    limitations: string[];
}

/** Check installed CLI capabilities and attempt the least invasive NCU counter query.
 * A successful metric query proves only that discovery worked; it is deliberately not
 * reported as proof that an actual kernel can be profiled.
 */
export async function checkNvidiaDiagnosticsEnvironment(config: Pick<NvidiaDiagnosticsConfig, 'ncuPath' | 'sanitizerPath' | 'reportDirectory' | 'timeoutMs' | 'cwd' | 'gpuQueryPath'>): Promise<{ report: NvidiaEnvironmentReport; jsonPath: string; rawPath: string }> {
    const cwd = path.resolve(config.cwd ?? process.cwd());
    const directory = path.resolve(cwd, config.reportDirectory);
    await mkdir(directory, { recursive: true });
    const base = path.join(directory, `nvidia-environment-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
    const report: NvidiaEnvironmentReport = {
        schemaVersion: 1, createdAt: new Date().toISOString(),
        ncu: { state: 'error', version: null, details: '' }, sanitizer: { state: 'error', version: null, details: '' },
        gpu: { available: null, model: null, driverVersion: null, details: '' },
        counters: { status: 'unknown-error', operation: null, discoveredMetricCount: null, details: '' }, limitations: []
    };
    const getTool = async (file: string): Promise<{ state: EnvironmentState; version: string | null; details: string; help: string }> => {
        const version = await run(file, ['--version'], config.timeoutMs, cwd);
        const details = `${version.stdout}${version.stderr}`.trim();
        if (version.launchError && /ENOENT|not found|cannot find/i.test(details)) {return { state: 'missing', version: null, details, help: '' };}
        if (version.code !== 0 || version.timedOut || version.launchError) {return { state: 'error', version: null, details: details || `version command exited ${version.code}`, help: '' };}
        const help = await run(file, ['--help'], config.timeoutMs, cwd);
        return { state: 'available', version: details || null, details: `${details}${help.stdout || help.stderr ? `\n--help output captured (${help.code === 0 ? 'exit 0' : `exit ${help.code}`}).` : ''}`, help: `${help.stdout}\n${help.stderr}` };
    };
    const [ncu, sanitizer, gpu] = await Promise.all([
        getTool(config.ncuPath), getTool(config.sanitizerPath),
        run(config.gpuQueryPath ?? 'nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader'], Math.min(config.timeoutMs, 10000), cwd)
    ]);
    report.ncu = { state: ncu.state, version: ncu.version, details: ncu.details };
    report.sanitizer = { state: sanitizer.state, version: sanitizer.version, details: sanitizer.details };
    const gpuText = `${gpu.stdout}${gpu.stderr}`.trim();
    const gpuLine = gpu.stdout.trim().split(/\r?\n/)[0] ?? '';
    if (gpu.code === 0 && gpuLine) {
        const [model, driverVersion] = gpuLine.split(',').map(item => item.trim());
        report.gpu = { available: true, model: model || null, driverVersion: driverVersion || null, details: gpuText };
    } else {
        const missingGpu = /no devices|no cuda-capable|no devices were found/i.test(gpuText);
        const missingUtility = gpu.launchError && /ENOENT|not found|cannot find/i.test(gpuText);
        report.gpu = { available: missingGpu ? false : null, model: null, driverVersion: null, details: gpuText || (missingUtility ? 'nvidia-smi was not found.' : 'nvidia-smi did not return GPU and driver details.') };
    }
    const helpSaysQuery = /--query-metrics\b/.test(ncu.help);
    const helpSaysMode = /--query-metrics-mode\b/.test(ncu.help);
    if (ncu.state === 'missing') {
        report.counters = { status: 'missing-tool', operation: null, discoveredMetricCount: null, details: ncu.details };
    } else if (ncu.state !== 'available') {
        report.counters = { status: 'unknown-error', operation: null, discoveredMetricCount: null, details: ncu.details };
    } else if (!helpSaysQuery) {
        report.counters = { status: 'unsupported-option', operation: '--query-metrics not advertised by ncu --help', discoveredMetricCount: null, details: ncu.help || 'No query-metrics capability advertised.' };
    } else {
        const queryArgs = ['--query-metrics', ...(helpSaysMode ? ['--query-metrics-mode', 'all'] : []), '--csv'];
        const query = await run(config.ncuPath, queryArgs, config.timeoutMs, cwd);
        const text = `${query.stdout}\n${query.stderr}`.trim();
        const metrics = parseNcuMetricNames(text);
        const permission = /ERR_NVGPUCTRPERM|permission.*(?:counter|performance)|(?:counter|performance).*permission/i.test(text);
        const noGpu = /no CUDA-capable device|no devices? (?:were )?(?:found|available)/i.test(text);
        const unsupported = /unknown option|unrecognized option|unsupported option|invalid (?:option|argument)|unknown argument/i.test(text);
        const details = text || `ncu query exited ${query.code} without output.`;
        report.counters = { status: permission ? 'permission-denied' : noGpu || report.gpu.available === false ? 'no-gpu' : unsupported ? 'unsupported-option' : query.code === 0 && metrics.length ? 'query-only-success-not-proof' : 'unknown-error', operation: queryArgs.join(' '), discoveredMetricCount: query.code === 0 ? metrics.length : null, details };
        if (query.timedOut) {report.counters.status = 'unknown-error'; report.counters.details += '\nThe metric query timed out.';}
    }
    if (report.counters.status === 'query-only-success-not-proof') {report.limitations.push('The metric query succeeded, but this does not prove that profiling a kernel or exporting an .ncu-rep will succeed.');}
    if (report.counters.status === 'permission-denied') {report.limitations.push('Counter access was denied. No system permissions or driver settings were changed.');}
    if (report.gpu.available === null) {report.limitations.push('GPU/driver availability is unknown because nvidia-smi could not be run.');}
    if (report.gpu.available === false) {report.limitations.push('No available GPU/driver was confirmed by nvidia-smi.');}
    const jsonPath = `${base}.json`, rawPath = `${base}.txt`;
    const raw = [`Nsight Compute: ${report.ncu.state}; ${report.ncu.version ?? 'version unavailable'}`, `Compute Sanitizer: ${report.sanitizer.state}; ${report.sanitizer.version ?? 'version unavailable'}`, `GPU: ${report.gpu.model ?? 'not detected'}; driver: ${report.gpu.driverVersion ?? 'not detected'}`, `Counter access: ${report.counters.status}`, report.counters.details].join('\n\n');
    await writeFile(jsonPath, JSON.stringify(report, null, 2), { encoding: 'utf8', mode: 0o600 });
    await writeFile(rawPath, raw, { encoding: 'utf8', mode: 0o600 });
    return { report, jsonPath, rawPath };
}
export function sanitizerStatus(result: ProcessResult): SanitizerResult['status'] {
    if (result.launchError || result.timedOut || result.cancelled || result.code === null) {return 'tool-error';}
    const output = `${result.stdout}\n${result.stderr}`;
    const summaries = [...output.matchAll(/ERROR SUMMARY:\s*(\d+)\s+(?:errors?|hazards?)/gi)];
    const raceSummaries = [...output.matchAll(/RACECHECK SUMMARY:\s*(\d+)\s+hazards? displayed\s*\((\d+) errors?,\s*(\d+) warnings?\)/gi)];
    const foundProblems = summaries.some(match => Number(match[1]) > 0) || raceSummaries.some(match => Number(match[1]) > 0 || Number(match[2]) > 0 || Number(match[3]) > 0) || /Potential hazards detected|Hazard detected|Error: Race reported|Uninitialized .* (?:read|access)|Invalid __global__|Invalid __shared__|Barrier error detected/i.test(output);
    if (foundProblems) {return 'problem';}
    // An exit code of zero alone is insufficient: a truncated or malformed tool run is not clean.
    const completedZeroSummary = summaries.some(match => Number(match[1]) === 0) || raceSummaries.some(match => Number(match[1]) === 0 && Number(match[2]) === 0 && Number(match[3]) === 0);
    if (result.code === 0 && completedZeroSummary) {return 'clean';}
    return 'tool-error';
}
async function writeReport(base: string, report: NvidiaDiagnosticReport): Promise<void> {
    await writeFile(`${base}.json`, JSON.stringify(report, null, 2), { encoding: 'utf8', mode: 0o600 });
    await writeFile(`${base}.txt`, [report.profile.output, ...report.sanitizers.map(item => `=== ${item.tool}: ${item.status} (exit ${item.exitCode ?? 'unknown'}) ===\n${item.output}`)].join('\n'), { encoding: 'utf8', mode: 0o600 });
}
export async function runNvidiaDiagnostics(executable: string, args: string[], config: NvidiaDiagnosticsConfig): Promise<{ report: NvidiaDiagnosticReport; jsonPath: string; rawPath: string }> {
    validateNvidiaDiagnosticsConfig(config);
    const cwd = path.resolve(config.cwd ?? process.cwd());
    const reportDirectory = path.resolve(cwd, config.reportDirectory);
    await mkdir(reportDirectory, { recursive: true });
    const base = path.join(reportDirectory, `nvidia-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
    const ncuReport = `${base}.ncu-rep`;
    const report: NvidiaDiagnosticReport = { schemaVersion: 1, createdAt: new Date().toISOString(), executable, args: [...args], cwd, gpu: null,
        ncuVersion: null, sanitizerVersion: null, profile: { status: 'not-run', requestedMetrics: [], unavailableMetrics: [], metrics: [], reportPath: null, output: '', exitCode: null },
        sanitizers: [], observations: [], hypotheses: [], limitations: [] };
    const jsonPath = `${base}.json`, rawPath = `${base}.txt`;
    try {
        const exePath = path.isAbsolute(executable) ? executable : path.resolve(cwd, executable);
        const exeStat = await stat(exePath); if (!exeStat.isFile()) {throw new Error(`CUDA executable is not a regular file: ${exePath}`);}
        if (process.platform !== 'win32') {await access(exePath, constants.X_OK);}
        report.executable = exePath;
        const [ncuVersion, sanitizerVersion, gpu] = await Promise.all([
            run(config.ncuPath, ['--version'], config.timeoutMs, cwd, config.signal), run(config.sanitizerPath, ['--version'], config.timeoutMs, cwd, config.signal),
            run(config.gpuQueryPath ?? 'nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], 5000, cwd, config.signal)
        ]);
        report.ncuVersion = ncuVersion.code === 0 ? `${ncuVersion.stdout}${ncuVersion.stderr}`.trim() : null;
        report.sanitizerVersion = sanitizerVersion.code === 0 ? `${sanitizerVersion.stdout}${sanitizerVersion.stderr}`.trim() : null;
        report.gpu = gpu.code === 0 ? gpu.stdout.trim().split(/\r?\n/)[0] || null : null;
        const query = await run(config.ncuPath, ['--query-metrics', '--query-metrics-mode', 'all', '--csv'], config.timeoutMs, cwd, config.signal);
        const queryOutput = query.stdout + query.stderr;
        const discovered = parseNcuMetricNames(queryOutput);
        const requestedMetrics = config.metrics?.length ? config.metrics : CANDIDATE_METRICS;
        const metrics = requestedMetrics.filter(name => discovered.includes(name));
        report.profile.requestedMetrics = [...requestedMetrics];
        report.profile.unavailableMetrics = query.code === 0 ? requestedMetrics.filter(name => !discovered.includes(name)) : [];
        if (query.cancelled) {report.profile.status = 'cancelled'; report.profile.output = queryOutput;}
        else if (/ERR_NVGPUCTRPERM|permission.*counter|access.*counter/i.test(queryOutput)) {report.profile.status = 'permission-denied'; report.profile.output = queryOutput;}
        else if (/no CUDA-capable device|no devices? (?:were )?(?:found|available)|device does not support profiling/i.test(queryOutput)) {report.profile.status = 'no-gpu'; report.profile.output = queryOutput;}
        else if (query.launchError || query.timedOut || query.code !== 0) {report.profile.status = query.timedOut ? 'timeout' : 'tool-error'; report.profile.exitCode = query.code; report.profile.output = queryOutput;}
        else if (!metrics.length) {report.profile.status = 'unsupported-metrics'; report.profile.output = queryOutput;}
        else if (!config.signal?.aborted) {
            const result = await run(config.ncuPath, ['--kernel-name', `regex:${config.kernelRegex}`, '--launch-count', String(config.launchCount), '--metrics', metrics.join(','), '--export', ncuReport, '--page', 'raw', '--csv', '--', exePath, ...args], config.timeoutMs, cwd, config.signal);
            const output = `${result.stdout}${result.stderr}`;
            const parsedMetrics = parseNcuCsv(output);
            let rawReportExists = false;
            try {rawReportExists = (await stat(ncuReport)).isFile();} catch { /* ncu may not have created a report. */ }
            const capturedNames = new Set(parsedMetrics.map(metric => metric.name));
            report.profile = { status: result.cancelled ? 'cancelled' : result.timedOut ? 'timeout' : result.launchError ? 'tool-error' : result.code === 0 && parsedMetrics.length ? 'completed' : result.code === 0 ? 'empty-output' : /ERR_NVGPUCTRPERM|permission.*counter|access.*counter/i.test(output) ? 'permission-denied' : 'tool-error', requestedMetrics: [...requestedMetrics], unavailableMetrics: [...new Set([...report.profile.unavailableMetrics, ...metrics.filter(name => !capturedNames.has(name))])], metrics: parsedMetrics, reportPath: rawReportExists ? ncuReport : null, output: `=== Metric discovery ===\n${queryOutput}\n=== Nsight Compute ===\n${output}`, exitCode: result.code };
        }
        report.sanitizers = [];
        for (const tool of ['memcheck', 'racecheck', 'initcheck', 'synccheck'] as SanitizerTool[]) {
            if (!config.sanitizers.includes(tool)) {report.sanitizers.push({ tool, status: 'not-run', exitCode: null, output: 'Disabled by configuration.' }); continue;}
            if (config.signal?.aborted) {report.sanitizers.push({ tool, status: 'not-run', exitCode: null, output: 'Not started because the user cancelled the diagnostic run.' }); continue;}
            const result = await run(config.sanitizerPath, ['--tool', tool, '--error-exitcode', '86', ...(config.kernelRegex ? ['--kernel-name', `regex=${config.kernelRegex}`] : []), '--', exePath, ...args], config.timeoutMs, cwd, config.signal);
            const output = `${result.stdout}${result.stderr}`;
            report.sanitizers.push({ tool, status: result.cancelled ? 'not-run' : sanitizerStatus(result), exitCode: result.code, output: result.cancelled ? `Cancelled before the control completed. Partial output follows.\n${output}` : output, ...(result.cancelled ? { cancelled: true } : {}) });
        }
    } catch (error) {
        report.profile.status = 'tool-error'; report.profile.output = error instanceof Error ? error.message : String(error);
        report.sanitizers = (['memcheck', 'racecheck', 'initcheck', 'synccheck'] as SanitizerTool[]).map(tool => ({ tool, status: config.sanitizers.includes(tool) ? 'tool-error' : 'not-run', exitCode: null, output: config.sanitizers.includes(tool) ? `Setup failed before tool execution: ${report.profile.output}` : 'Disabled by configuration.' }));
    } finally {
        const evidence = summarizeMetricEvidence(report.profile.metrics);
        report.observations = evidence.observations; report.hypotheses = evidence.hypotheses;
        if (!report.gpu) {report.limitations.push('GPU model was not detected; no GPU availability is implied.');}
        if (!report.ncuVersion) {report.limitations.push('Nsight Compute version could not be read.');}
        if (!report.sanitizerVersion) {report.limitations.push('Compute Sanitizer version could not be read.');}
        if (report.profile.status === 'permission-denied') {report.limitations.push('Nsight Compute could not access hardware performance counters. No profiling values are available; system permissions were not changed.');}
        if (report.profile.status === 'no-gpu') {report.limitations.push('Nsight Compute reported no usable CUDA device. GPU metrics were not collected.');}
        if (report.profile.status === 'unsupported-metrics') {report.limitations.push('No requested candidate metric is supported by this tool/GPU, or metric discovery returned no parseable names.');}
        if (report.profile.unavailableMetrics.length) {report.limitations.push(`Metrics without reported values are listed explicitly: ${report.profile.unavailableMetrics.join(', ')}.`);}
        if (report.profile.status === 'timeout') {report.limitations.push('Nsight Compute timed out; partial console output and any partial .ncu-rep file are retained.');}
        if (config.signal?.aborted) {report.limitations.push('The user cancelled the run. Completed steps and partial outputs are retained; unstarted checks are marked not-run.');}
        report.limitations.push('Nsight Compute profiling is a separate execution from benchmark timing; profiler/replay duration is not a benchmark measurement.');
        report.limitations.push('A clean sanitizer status requires exit code 0 and an explicit zero-error/hazard summary.');
        await writeReport(base, report);
    }
    return { report, jsonPath, rawPath };
}
