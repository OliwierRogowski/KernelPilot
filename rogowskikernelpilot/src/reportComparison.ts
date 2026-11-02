import { createHash } from 'node:crypto';

export interface ComparisonOptions { practicalChangePercent: number; bootstrapIterations?: number; minimumSamples?: number; }
export interface MetricSummary { key: string; scope: string; count: number; medianMs: number | null; minMs: number | null; maxMs: number | null; spreadPercent: number | null; samplesMs: number[]; summaryOnly?: boolean; }
export interface PerformanceComparison { key: string; scope: string; baseline: MetricSummary; candidate: MetricSummary; speedup: number | null; timeChangePercent: number | null; speedupCi95: [number, number] | null; result: 'improvement' | 'regression' | 'inconclusive' | 'invalid-data'; evidence: string[]; }
export interface ReportComparison {
    schema: 'kernelpilot-report-comparison-v1'; createdAt: string; baselinePath: string; candidatePath: string;
    comparability: { status: 'comparable' | 'uncertain' | 'incomparable'; findings: Array<{ severity: 'information' | 'uncertainty' | 'material'; field: string; baseline: string | null; candidate: string | null; explanation: string }> };
    performance: PerformanceComparison[]; overallPerformance: 'improvement' | 'regression' | 'inconclusive' | 'incomparable'; practicalChangePercent: number;
    correctness: { baseline: string; candidate: string; candidateRecommendationAllowed: boolean; evidence: string[] };
    sanitizers: { baseline: unknown[]; candidate: unknown[] };
    ncu: { comparable: Array<{ kernel: string; launchId: string; name: string; unit: string; baseline: string; candidate: string; changePercent: number | null }>; unavailable: string[] };
    recommendation: { status: 'recommend' | 'do-not-recommend' | 'no-conclusion'; reason: string; evidence: string[] };
}

type Json = Record<string, any>;
interface Normalized { performance: MetricSummary[]; attributes: Record<string, string | null>; correctness: string; sanitizers: unknown[]; metrics: Array<{ kernel: string; launchId: string; name: string; value: string; unit: string | null }>; }

function object(value: unknown): Json {return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};}
function str(value: unknown): string | null {return typeof value === 'string' && value.trim() ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : null;}
function stable(value: unknown): string | null {
    if (value === undefined || value === null || value === '') {return null;}
    if (typeof value === 'string') {return value.trim();}
    try {return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);}
    catch {return String(value);}
}
function median(values: number[]): number {const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;}
function summarize(key: string, scope: string, raw: unknown[]): MetricSummary {
    const samplesMs = raw.filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
    const hasInvalid = samplesMs.length !== raw.length;
    if (hasInvalid || !samplesMs.length) {return { key, scope, count: raw.length, medianMs: null, minMs: null, maxMs: null, spreadPercent: null, samplesMs };}
    const minMs = Math.min(...samplesMs), maxMs = Math.max(...samplesMs), medianMs = median(samplesMs);
    return { key, scope, count: samplesMs.length, medianMs, minMs, maxMs, spreadPercent: ((maxMs - minMs) / medianMs) * 100, samplesMs };
}
function extract(report: Json): Normalized {
    const groups = new Map<string, { scope: string; samples: unknown[] }>();
    const add = (key: string, scope: string, value: unknown) => {const entry = groups.get(key) ?? { scope, samples: [] }; entry.samples.push(value); groups.set(key, entry);};
    const phases = Array.isArray(report.rawPhaseSamples) ? report.rawPhaseSamples : [];
    for (const itemValue of phases) {
        const item = object(itemValue);
        if (item.backend && item.backend !== 'CUDA') {continue;}
        const phase = str(item.phase); const size = str(item.size);
        if (!phase || !size) {continue;}
        const key = `${phase} · ${size}`;
        add(key, phase, item.milliseconds);
    }
    const sourceSamples = Array.isArray(report.rawSamples) ? report.rawSamples : [];
    for (const itemValue of sourceSamples) {
        const item = object(itemValue), kernel = str(item.kernel);
        if (!kernel) {continue;}
        add(`kernel · ${kernel}`, 'CUDA event per kernel invocation', item.milliseconds);
    }
    // Schema-1 experiment manifests keep one timing summary per correctness case.
    const cases = Array.isArray(object(report.benchmark).cases) ? report.benchmark.cases : [];
    for (const itemValue of cases) {
        const item = object(itemValue), name = str(item.name);
        if (name) {add(`case · ${name}`, 'reported median per correctness case', item.medianMs ?? item.median_ms);}
    }
    if (!groups.size && Array.isArray(report.results)) {
        for (const itemValue of report.results) {const item = object(itemValue), key = str(item.caseName ?? item.name); if (key) {add(`case · ${key}`, 'reported case median', item.medianMs);}}
    }
    const performance = [...groups].map(([key, group]) => summarize(key, group.scope, group.samples));
    if (!performance.length && Array.isArray(report.summaries)) {
        for (const value of report.summaries) {
            const item = object(value), kernel = str(item.kernel), center = item.medianMs ?? item.median;
            if (!kernel || typeof center !== 'number' || !Number.isFinite(center) || center <= 0) {continue;}
            const count = Number(item.count ?? 0), min = Number(item.minMs ?? item.min), max = Number(item.maxMs ?? item.max);
            performance.push({ key: `kernel · ${kernel}`, scope: 'legacy summary only; no raw samples', count: Number.isFinite(count) && count > 0 ? count : 0, medianMs: center,
                minMs: Number.isFinite(min) && min > 0 ? min : null, maxMs: Number.isFinite(max) && max > 0 ? max : null,
                spreadPercent: Number.isFinite(min) && Number.isFinite(max) && min > 0 && max >= min ? ((max - min) / center) * 100 : null, samplesMs: [], summaryOnly: true });
        }
    }
    const env = object(report.environment), workload = object(report.workload), timerScope = object(report.timerScope), diag = object(report.nvidiaDiagnostics);
    const validation = object(report.cudaResultValidation), optimization = object(report.optimizationGate);
    let correctness = str(validation.status) ?? str(report.correctnessStatus) ?? str(object(report.validation).status) ?? str(report.validation);
    if (!correctness && str(optimization.status) === 'incorrect') {correctness = 'failed';}
    if (!correctness && typeof report.correctness === 'string') {
        const text = report.correctness.toLowerCase();
        correctness = /failed|incorrect/.test(text) ? 'failed' : /not\s+.*(verified|validated)|unverified|unvalidated|unknown/.test(text) ? 'not-validated' : /\bpassed\b|\bverified\b/.test(text) ? 'passed' : 'not-validated';
    }
    correctness ??= 'not-validated';
    const diagnosticReport = object(diag.report);
    const ncuProfile = object(diagnosticReport.profile ?? report.profile);
    const rawMetrics = Array.isArray(ncuProfile.metrics) ? ncuProfile.metrics : [];
    const metrics = rawMetrics.map((itemValue: unknown) => {const item = object(itemValue); return { kernel: str(item.kernel) ?? '', launchId: str(item.launchId) ?? '', name: str(item.name) ?? '', value: str(item.value) ?? '', unit: str(item.unit) };}).filter((item: { kernel: string; launchId: string; name: string; value: string }) => item.kernel && item.launchId && item.name && item.value);
    const nvidia = object(report.nvidiaDiagnostics), sanitizers = Array.isArray(nvidia.report?.sanitizers) ? nvidia.report.sanitizers : Array.isArray(report.sanitizers) ? report.sanitizers : [];
    const compile = object(report.compilation);
    const gpu = str(report.gpu ?? report.gpuModel ?? env.gpu ?? env.gpuModel ?? object(nvidia.report).gpu ?? object(report.toolchain).gpu);
    const inputHash = str(report.inputSha256 ?? report.inputHash ?? workload.inputSha256 ?? workload.inputHash ?? object(report.cudaResultValidation).inputSha256);
    const inputData = stable(report.elementCounts ?? report.inputCount ?? workload.actualElementsPerAdapterCall ?? workload.harnessArguments ?? workload.elementCount ?? report.input);
    const runParams = stable(report.args ?? report.parameters ?? report.runParameters ?? (report.warmupRuns !== undefined || report.measuredProgramRuns !== undefined || report.launchSites !== undefined ? { warmupRuns: report.warmupRuns, measuredProgramRuns: report.measuredProgramRuns, launch: report.launchSites } : null));
    const method = stable(report.timerScope ?? report.timingMethod ?? report.method ?? performance.map(item => item.scope));
    const compileInfo = stable({ compiler: report.compiler, compilerVersion: report.compilerVersion ?? report.toolchain?.nvcc, architecture: report.architecture ?? report.gpuArchitecture });
    const buildArguments = stable(report.compileArguments ?? report.compile_arguments ?? report.compilerFlags);
    const environment = stable(report.environment ?? report.toolchain ?? { compiler: report.compilerVersion, architecture: report.architecture });
    return { performance, attributes: { gpu, inputHash, inputData, runParams, method, compileInfo, buildArguments, environment }, correctness, sanitizers, metrics };
}

function compatibility(a: Normalized, b: Normalized): ReportComparison['comparability'] {
    const findings: ReportComparison['comparability']['findings'] = [];
    const checks: Array<[string, string | null, string | null, boolean]> = [
        ['GPU model', a.attributes.gpu, b.attributes.gpu, true], ['input hash', a.attributes.inputHash, b.attributes.inputHash, true],
        ['input data/size', a.attributes.inputData, b.attributes.inputData, true], ['run parameters', a.attributes.runParams, b.attributes.runParams, true],
        ['timing method and scope', a.attributes.method, b.attributes.method, true], ['compiler/toolchain', a.attributes.compileInfo, b.attributes.compileInfo, false],
        ['environment', a.attributes.environment, b.attributes.environment, false]
    ];
    for (const [field, baseline, candidate, materialWhenDifferent] of checks) {
        if (!baseline || !candidate) {findings.push({ severity: 'uncertainty', field, baseline, candidate, explanation: `Missing ${field} metadata; equivalence cannot be confirmed.` });}
        else if (baseline !== candidate) {findings.push({ severity: materialWhenDifferent ? 'material' : 'uncertainty', field, baseline, candidate, explanation: materialWhenDifferent ? `${field} differ, so the timing comparison is descriptive and reports are treated as incomparable.` : `${field} differ; this may contribute to timing differences.` });}
        else {findings.push({ severity: 'information', field, baseline, candidate, explanation: `${field} match.` });}
    }
    const baselineFlags = a.attributes.buildArguments, candidateFlags = b.attributes.buildArguments;
    if (!baselineFlags || !candidateFlags) {findings.push({ severity: 'uncertainty', field: 'build arguments', baseline: baselineFlags, candidate: candidateFlags, explanation: 'Build arguments are missing; optimization and code generation flags cannot be compared.' });}
    else if (baselineFlags !== candidateFlags) {findings.push({ severity: 'information', field: 'build arguments', baseline: baselineFlags, candidate: candidateFlags, explanation: 'Build arguments differ; inspect the flags because they affect generated code.' });}
    else {findings.push({ severity: 'information', field: 'build arguments', baseline: baselineFlags, candidate: candidateFlags, explanation: 'Build arguments match.' });}
    return { status: findings.some(item => item.severity === 'material') ? 'incomparable' : findings.some(item => item.severity === 'uncertainty') ? 'uncertain' : 'comparable', findings };
}
function bootstrapRatio(a: number[], b: number[], iterations: number, minSamples: number, salt: string): [number, number] | null {
    if (a.length < minSamples || b.length < minSamples || a.some(x => !Number.isFinite(x) || x <= 0) || b.some(x => !Number.isFinite(x) || x <= 0)) {return null;}
    // Deterministic percentile bootstrap of independent sample medians; no pairing assumption.
    let state = createHash('sha256').update(salt).digest().readUInt32LE(0) || 1;
    const random = () => {state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x100000000;};
    const ratios: number[] = [];
    for (let i = 0; i < iterations; i++) {
        const left = Array.from({ length: a.length }, () => a[Math.floor(random() * a.length)]);
        const right = Array.from({ length: b.length }, () => b[Math.floor(random() * b.length)]);
        ratios.push(median(left) / median(right));
    }
    ratios.sort((x, y) => x - y);
    return [ratios[Math.floor(0.025 * (ratios.length - 1))], ratios[Math.ceil(0.975 * (ratios.length - 1))]];
}
function compareOne(a: MetricSummary, b: MetricSummary, options: ComparisonOptions): PerformanceComparison {
    const evidence = [`Baseline: n=${a.count}, median=${a.medianMs ?? 'unavailable'} ms, range=${a.minMs ?? 'unavailable'}–${a.maxMs ?? 'unavailable'} ms.`, `Candidate: n=${b.count}, median=${b.medianMs ?? 'unavailable'} ms, range=${b.minMs ?? 'unavailable'}–${b.maxMs ?? 'unavailable'} ms.`];
    if (!a.medianMs || !b.medianMs || a.medianMs <= 0 || b.medianMs <= 0) {return { key: a.key, scope: a.scope, baseline: a, candidate: b, speedup: null, timeChangePercent: null, speedupCi95: null, result: 'invalid-data', evidence: [...evidence, 'Times must be finite and strictly positive; invalid or zero values prevent this comparison.'] };}
    const speedup = a.medianMs / b.medianMs, timeChangePercent = ((b.medianMs - a.medianMs) / a.medianMs) * 100;
    const ci = bootstrapRatio(a.samplesMs, b.samplesMs, options.bootstrapIterations ?? 5000, options.minimumSamples ?? 5, `${a.key}:${a.samplesMs.join(',')}:${b.samplesMs.join(',')}`);
    const practical = options.practicalChangePercent / 100;
    let result: PerformanceComparison['result'] = 'inconclusive';
    if (ci && ci[0] > 1 + practical) {result = 'improvement';}
    else if (ci && ci[1] < 1 - practical) {result = 'regression';}
    evidence.push(ci ? `Independent percentile bootstrap of median speedup, 95% interval [${ci[0].toFixed(4)}, ${ci[1].toFixed(4)}], iterations=${options.bootstrapIterations ?? 5000}; practical threshold=±${options.practicalChangePercent}%.` : `Uncertainty unresolved: at least ${options.minimumSamples ?? 5} raw valid samples per report are required; available n=${a.samplesMs.length}/${b.samplesMs.length}. Summary-only legacy timing cannot establish uncertainty.`);
    evidence.push('Bootstrap assumes independent, representative samples from comparable runs; it does not correct thermal drift, serial run-order effects, or different workloads.');
    return { key: a.key, scope: a.scope, baseline: a, candidate: b, speedup, timeChangePercent, speedupCi95: ci, result, evidence };
}
function compareNcu(a: Normalized['metrics'], b: Normalized['metrics']): ReportComparison['ncu'] {
    const comparable: ReportComparison['ncu']['comparable'] = [], unavailable: string[] = [];
    const key = (item: Normalized['metrics'][number]) => `${item.kernel}\0${item.launchId}\0${item.name}`;
    const left = new Map<string, typeof a>(); const right = new Map<string, typeof b>();
    for (const metric of a) {if (metric.kernel === 'unknown' || metric.launchId === 'unknown') {unavailable.push(`${metric.name}: baseline kernel/launch identity is unavailable.`); continue;} left.set(key(metric), [...(left.get(key(metric)) ?? []), metric]);}
    for (const metric of b) {if (metric.kernel === 'unknown' || metric.launchId === 'unknown') {unavailable.push(`${metric.name}: candidate kernel/launch identity is unavailable.`); continue;} right.set(key(metric), [...(right.get(key(metric)) ?? []), metric]);}
    for (const [id, lm] of left) {
        const rm = right.get(id), [kernel, launchId, name] = id.split('\0');
        if (!rm || lm.length !== 1 || rm.length !== 1 || !lm[0].unit || lm[0].unit !== rm[0].unit) {unavailable.push(`${kernel} launch ${launchId} ${name}: missing/ambiguous match or units differ.`); continue;}
        const x = Number(lm[0].value), y = Number(rm[0].value);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {unavailable.push(`${kernel} launch ${launchId} ${name}: non-numeric metric value.`); continue;}
        comparable.push({ kernel, launchId, name, unit: lm[0].unit, baseline: lm[0].value, candidate: rm[0].value, changePercent: x === 0 ? null : ((y - x) / Math.abs(x)) * 100 });
    }
    for (const metric of b) {if (metric.kernel !== 'unknown' && metric.launchId !== 'unknown' && !left.has(key(metric))) {unavailable.push(`${metric.kernel} launch ${metric.launchId} ${metric.name}: no baseline match.`);}}
    if (!a.length || !b.length) {unavailable.push('NCU metrics are unavailable in one or both reports; no counter comparison was made.');}
    return { comparable, unavailable };
}

export function compareKernelPilotReports(baselineReport: Json, candidateReport: Json, baselinePath: string, candidatePath: string, options: ComparisonOptions): ReportComparison {
    if (!Number.isFinite(options.practicalChangePercent) || options.practicalChangePercent < 0 || options.practicalChangePercent > 100) {throw new Error('Practical change threshold must be between 0 and 100 percent.');}
    const baseline = extract(baselineReport), candidate = extract(candidateReport), comparability = compatibility(baseline, candidate);
    const rightByKey = new Map(candidate.performance.map(item => [item.key, item]));
    const performance = baseline.performance.flatMap(item => {const other = rightByKey.get(item.key); return other ? [compareOne(item, other, options)] : [];});
    for (const item of baseline.performance) {if (!rightByKey.has(item.key)) {comparability.findings.push({ severity: 'material', field: 'timing scopes', baseline: item.key, candidate: null, explanation: `No candidate timing with matching scope ${item.key}.` });}}
    for (const item of candidate.performance) {if (!baseline.performance.some(left => left.key === item.key)) {comparability.findings.push({ severity: 'material', field: 'timing scopes', baseline: null, candidate: item.key, explanation: `No baseline timing with matching scope ${item.key}.` });}}
    if (comparability.findings.some(item => item.severity === 'material')) {comparability.status = 'incomparable';}
    else if (comparability.findings.some(item => item.severity === 'uncertainty')) {comparability.status = 'uncertain';}
    let overallPerformance: ReportComparison['overallPerformance'] = 'inconclusive';
    if (comparability.status === 'incomparable' || !performance.length) {overallPerformance = 'incomparable';}
    else if (performance.length && performance.every(item => item.result === 'improvement')) {overallPerformance = 'improvement';}
    else if (performance.some(item => item.result === 'regression')) {overallPerformance = 'regression';}
    const correctnessEvidence = [
        `Baseline correctness status: ${baseline.correctness}.`, `Candidate correctness status: ${candidate.correctness}.`
    ];
    const candidateValid = candidate.correctness.toLowerCase() === 'passed';
    const candidateInvalid = ['failed', 'incorrect', 'correctness_failed'].includes(candidate.correctness.toLowerCase()) || str(object(candidateReport.optimizationGate).status) === 'incorrect';
    const candidateRecommendationAllowed = candidateValid && !candidateInvalid;
    const recommendation = candidateInvalid
        ? { status: 'do-not-recommend' as const, reason: 'Candidate correctness failed; measured performance cannot make it a recommended optimization.', evidence: correctnessEvidence }
        : comparability.status !== 'comparable' || overallPerformance === 'incomparable'
            ? { status: 'no-conclusion' as const, reason: comparability.status === 'uncertain' ? 'Missing comparison metadata leaves equivalence uncertain.' : 'Reports contain material mismatches or no common timing scope.', evidence: comparability.findings.filter(item => item.severity === 'material' || item.severity === 'uncertainty').map(item => item.explanation) }
            : overallPerformance === 'improvement' && candidateRecommendationAllowed
                ? { status: 'recommend' as const, reason: 'Candidate passed correctness and every compared timing scope shows a bootstrap interval beyond the practical improvement threshold.', evidence: performance.flatMap(item => item.evidence) }
                : { status: 'no-conclusion' as const, reason: candidateValid ? 'Performance evidence does not establish an improvement beyond the practical threshold.' : 'Candidate correctness is not confirmed; missing validation or tool-error cannot establish correctness.', evidence: [...correctnessEvidence, ...performance.flatMap(item => item.evidence)] };
    return { schema: 'kernelpilot-report-comparison-v1', createdAt: new Date().toISOString(), baselinePath, candidatePath, comparability, performance, overallPerformance,
        practicalChangePercent: options.practicalChangePercent, correctness: { baseline: baseline.correctness, candidate: candidate.correctness, candidateRecommendationAllowed, evidence: correctnessEvidence },
        sanitizers: { baseline: baseline.sanitizers, candidate: candidate.sanitizers }, ncu: compareNcu(baseline.metrics, candidate.metrics), recommendation };
}

export function renderComparisonMarkdown(result: ReportComparison): string {
    const rows = result.performance.map(item => `| ${item.key} (${item.scope}) | ${item.baseline.medianMs?.toPrecision(6) ?? '—'} | ${item.baseline.count} | ${item.baseline.spreadPercent?.toFixed(1) ?? '—'}% | ${item.candidate.medianMs?.toPrecision(6) ?? '—'} | ${item.candidate.count} | ${item.candidate.spreadPercent?.toFixed(1) ?? '—'}% | ${item.speedup?.toFixed(3) ?? '—'}× | ${item.timeChangePercent?.toFixed(1) ?? '—'}% | ${item.result} |`).join('\n');
    const compatibility = result.comparability.findings.map(item => `- **${item.severity} · ${item.field}:** ${item.explanation} (baseline=${item.baseline ?? 'missing'}; candidate=${item.candidate ?? 'missing'})`).join('\n');
    const metrics = result.ncu.comparable.map(item => `- ${item.kernel} launch ${item.launchId}: ${item.name} ${item.baseline} → ${item.candidate} ${item.unit}${item.changePercent === null ? '' : ` (${item.changePercent.toFixed(1)}%)`}`).join('\n') || '- No unambiguous same-unit NCU metrics.';
    const statisticalEvidence = result.performance.flatMap(item => [`**${item.key}: ${item.result}**`, ...item.evidence.map(evidence => `- ${evidence}`)]).join('\n');
    return `# KernelPilot report comparison\n\n- Performance: **${result.overallPerformance}**\n- Correctness: baseline **${result.correctness.baseline}**, candidate **${result.correctness.candidate}**\n- Recommendation: **${result.recommendation.status}** — ${result.recommendation.reason}\n- Practical threshold: ±${result.practicalChangePercent}%\n\n## Performance\n\n| Scope | Baseline median ms | n | range/median | Candidate median ms | n | range/median | Speedup | Time change | Result |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---|\n${rows || '| No matched timing scope | — | 0 | — | — | 0 | — | — | — | inconclusive |'}\n\n## Statistical evidence and limitations\n\n${statisticalEvidence || 'No common raw timing scope was available.'}\n\nWhen both sides have at least five valid samples, uncertainty uses an independent percentile bootstrap of median speedup (95% interval, 5,000 resamples). The method assumes independent, representative samples; it cannot remove thermal drift, run-order effects, or workload mismatch. A result is directional only when its interval clears the practical threshold.\n\n## Comparability\n\n${compatibility}\n\n## Correctness\n\n${result.correctness.evidence.map(item => `- ${item}`).join('\n')}\n\n## Compute Sanitizer\n\n- Baseline: ${JSON.stringify(result.sanitizers.baseline)}\n- Candidate: ${JSON.stringify(result.sanitizers.candidate)}\n\n## Nsight Compute\n\n${metrics}\n\n${result.ncu.unavailable.map(item => `- ${item}`).join('\n') || ''}\n\n## Recommendation evidence\n\n${result.recommendation.evidence.map(item => `- ${item}`).join('\n')}\n`;
}
