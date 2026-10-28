export interface HarnessMeasurement {
    caseName: string;
    passed: boolean;
    medianMs: number;
    p95Ms: number;
}

export interface BenchmarkDecision {
    status: 'accepted' | 'performance_regression' | 'correctness_failed' | 'cannot_confirm';
    medianSpeedup: number | null;
    details: string;
}

export function parseHarnessOutput(stdout: string): HarnessMeasurement[] {
    const results: HarnessMeasurement[] = [];
    for (const line of stdout.split(/\r?\n/)) {
        if (!line.startsWith('KP_RESULT,')) {continue;}
        const match = line.match(/^KP_RESULT,([A-Za-z0-9_.:-]{1,100}),(PASS|FAIL),([0-9]+(?:\.[0-9]+)?),([0-9]+(?:\.[0-9]+)?)$/);
        if (!match) {throw new Error(`Malformed validation harness record: ${line.slice(0, 200)}`);}
        const medianMs = Number(match[3]); const p95Ms = Number(match[4]);
        if (!Number.isFinite(medianMs) || !Number.isFinite(p95Ms) || medianMs <= 0 || p95Ms < medianMs) {
            throw new Error(`Invalid benchmark statistics for case ${match[1]}.`);
        }
        if (results.some(result => result.caseName === match[1])) {throw new Error(`Duplicate validation case ${match[1]}.`);}
        results.push({ caseName: match[1], passed: match[2] === 'PASS', medianMs, p95Ms });
    }
    if (!results.length) {throw new Error('Validation harness produced no KP_RESULT records.');}
    return results;
}

export function compareCudaRuns(original: HarnessMeasurement[], candidate: HarnessMeasurement[]): BenchmarkDecision {
    if (original.length < 3 || candidate.length < 3) {
        return { status: 'cannot_confirm', medianSpeedup: null, details: 'At least three deterministic input sizes are required in both runs.' };
    }
    const byName = new Map(candidate.map(result => [result.caseName, result]));
    if (byName.size !== candidate.length || original.some(result => !byName.has(result.caseName)) ||
        candidate.some(result => !original.some(base => base.caseName === result.caseName))) {
        return { status: 'cannot_confirm', medianSpeedup: null, details: 'Original and candidate harness runs did not report the same test cases.' };
    }
    if (original.some(result => !result.passed) || candidate.some(result => !result.passed)) {
        return { status: 'correctness_failed', medianSpeedup: null, details: 'At least one harness correctness case failed for the original or candidate. No speedup is reported.' };
    }
    const unstable = [...original, ...candidate].filter(result => result.p95Ms / result.medianMs > 1.2);
    if (unstable.length) {
        return { status: 'cannot_confirm', medianSpeedup: null, details: `Timing spread exceeded the 20% p95/median stability limit for ${unstable.map(item => item.caseName).join(', ')}. Repeat the measurement under more stable conditions.` };
    }
    const speedups = original.map(base => base.medianMs / byName.get(base.caseName)!.medianMs).sort((a, b) => a - b);
    const medianSpeedup = median(speedups);
    const regressions = original.filter(base => base.medianMs / byName.get(base.caseName)!.medianMs < 0.98);
    if (medianSpeedup < 1.02 || regressions.length) {
        return {
            status: 'performance_regression', medianSpeedup,
            details: regressions.length
                ? `Median per-case ratio ${medianSpeedup.toFixed(3)}x; performance regressed by more than 2% in ${regressions.map(item => item.caseName).join(', ')}.`
                : `Median per-case ratio ${medianSpeedup.toFixed(3)}x did not exceed the 1.02x acceptance threshold.`
        };
    }
    return {
        status: 'accepted', medianSpeedup,
        details: `Harness reports matching correctness passes and median per-case ratio ${medianSpeedup.toFixed(3)}x across ${original.length} input sizes. Original and candidate runs use separate invocations, so the result depends on stability and the supplied harness/target GPU environment.`
    };
}

function median(values: number[]): number {
    const middle = Math.floor(values.length / 2);
    return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}
