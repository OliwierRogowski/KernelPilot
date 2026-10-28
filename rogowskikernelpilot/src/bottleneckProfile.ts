import type { CudaMetricSample } from './cudaMetrics';

export type ProfilePhase = 'preparation_allocation' | 'h2d' | 'kernel' | 'd2h';
export interface ProfilePhaseSample { phase: ProfilePhase; size: number; sample: number; milliseconds: number; }
export interface BottleneckFinding {
    size: number; status: 'dominant' | 'unresolved'; phase?: ProfilePhase; medianLeader?: ProfilePhase;
    reason: string; medians: Partial<Record<ProfilePhase, number>>;
    winsByPhase: Partial<Record<Exclude<ProfilePhase, 'preparation_allocation'>, number>>;
    ties: number; completeSampleCount: number; missingSamples: number;
}

const measuredPhases = ['h2d', 'kernel', 'd2h'] as const;
function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function unresolved(size: number, reason: string, medians: Partial<Record<ProfilePhase, number>> = {}, winsByPhase: BottleneckFinding['winsByPhase'] = {}, ties = 0, completeSampleCount = 0, missingSamples = 0): BottleneckFinding {
    return { size, status: 'unresolved', reason, medians, winsByPhase, ties, completeSampleCount, missingSamples };
}

/** Setup is a one-off observation and is reported separately. Repeated phase comparisons pair by n and sample ID. */
export function analyzeBottlenecks(samples: ProfilePhaseSample[], cudaAvailable: boolean): BottleneckFinding[] {
    if (!cudaAvailable) {return [unresolved(0, 'No actual CUDA phase samples are available; only CPU measurements can be reported.')];}
    const sizes = [...new Set(samples.map(sample => sample.size))].sort((a, b) => a - b);
    if (!sizes.length) {return [unresolved(0, 'No CUDA phase samples were received.')];}
    return sizes.map(size => {
        const atSize = samples.filter(sample => sample.size === size && sample.phase !== 'preparation_allocation');
        if (atSize.some(item => !Number.isFinite(item.milliseconds) || item.milliseconds <= 0)) {
            return unresolved(size, 'A phase time is missing, zero, or invalid; dominance cannot be assessed.');
        }
        const maps = new Map<(typeof measuredPhases)[number], Map<number, number>>();
        const medians: Partial<Record<ProfilePhase, number>> = {};
        let missingSamples = 0;
        for (const phase of measuredPhases) {
            const rows = atSize.filter(item => item.phase === phase);
            const byId = new Map<number, number>();
            for (const row of rows) {
                if (byId.has(row.sample)) {return unresolved(size, `Duplicate ${phase} record for sample ${row.sample}.`, medians);}
                byId.set(row.sample, row.milliseconds);
            }
            maps.set(phase, byId);
            if (rows.length >= 5) {medians[phase] = median(rows.map(row => row.milliseconds));}
        }
        const allIds = new Set(atSize.map(row => row.sample));
        const completeIds = [...allIds].filter(id => measuredPhases.every(phase => maps.get(phase)?.has(id))).sort((a, b) => a - b);
        missingSamples = allIds.size - completeIds.length;
        if (Object.keys(medians).length < 2) {return unresolved(size, 'Fewer than two phases have at least five measurements.', medians, {}, 0, completeIds.length, missingSamples);}
        if (completeIds.length < 5) {return unresolved(size, `Only ${completeIds.length} complete phase groups are available; at least five are required.`, medians, {}, 0, completeIds.length, missingSamples);}

        const winsByPhase: BottleneckFinding['winsByPhase'] = { h2d: 0, kernel: 0, d2h: 0 };
        let ties = 0;
        for (const id of completeIds) {
            const values = measuredPhases.map(phase => ({ phase, time: maps.get(phase)!.get(id)! }));
            const maximum = Math.max(...values.map(value => value.time));
            const winners = values.filter(value => value.time === maximum);
            if (winners.length > 1) {ties++;}
            else {winsByPhase[winners[0].phase] = (winsByPhase[winners[0].phase] ?? 0) + 1;}
        }
        const ranked = measuredPhases.filter(phase => medians[phase] !== undefined)
            .sort((a, b) => medians[b]! - medians[a]!);
        const medianLeader = ranked[0]; const runnerUp = ranked[1];
        if (runnerUp !== undefined && medians[medianLeader] === medians[runnerUp]) {
            const tied = ranked.filter(phase => medians[phase] === medians[medianLeader]).join(', ');
            return unresolved(size, `Highest phase medians are tied (${tied}); per-sample wins are reported but there is no unique median leader.`, medians, winsByPhase, ties, completeIds.length, missingSamples);
        }
        const leaderWins = winsByPhase[medianLeader] ?? 0;
        const decisive = Object.values(winsByPhase).reduce((sum, value) => sum + (value ?? 0), 0);
        const summary = `${medianLeader} has the highest phase median (${medians[medianLeader]!.toFixed(6)} ms). Per-sample unique phase leaders: H2D ${winsByPhase.h2d}/${completeIds.length}, kernel ${winsByPhase.kernel}/${completeIds.length}, D2H ${winsByPhase.d2h}/${completeIds.length}; tied groups=${ties}; complete groups=${completeIds.length}; missing/incomplete groups=${missingSamples}.`;
        if (missingSamples || completeIds.length < 5) {return unresolved(size, `${summary} Incomplete phase records prevent a stable dominance finding.`, medians, winsByPhase, ties, completeIds.length, missingSamples);}
        const clearlyLargerMedian = runnerUp !== undefined && medians[medianLeader]! >= medians[runnerUp]! * 1.25;
        const dominatesSamples = leaderWins >= Math.ceil(completeIds.length * 0.8) && leaderWins > 0 && ties === 0;
        if (!clearlyLargerMedian || !dominatesSamples || decisive !== completeIds.length) {
            return unresolved(size, `${summary} The phase with the highest median does not dominate enough complete samples or costs are close. No bandwidth, compute-throughput, or occupancy limit is inferred.`, medians, winsByPhase, ties, completeIds.length, missingSamples);
        }
        return { size, status: 'dominant', phase: medianLeader, medianLeader, reason: `${summary} This is a measured time cost only, not evidence of a bandwidth, compute-throughput, or occupancy limit.`, medians, winsByPhase, ties, completeSampleCount: completeIds.length, missingSamples };
    });
}

export function profileExperiment(finding: BottleneckFinding): string {
    if (finding.status !== 'dominant') {return 'Unmeasured hypothesis: gather more matched phase samples and inspect the complete program scope before changing data placement or kernel configuration.';}
    switch (finding.phase) {
        case 'h2d': return 'Hypothesis for a separate benchmark: retain input data on the device across later operations and reduce repeated copies, only if source semantics permit it.';
        case 'preparation_allocation': return 'Hypothesis for a separate benchmark: reuse buffers. Current setup timing combines allocation and data preparation.';
        case 'kernel': return 'Hypothesis for a separate benchmark: compare block configurations and algorithm implementations; improvement is not guaranteed.';
        case 'd2h': return 'Hypothesis for a separate benchmark: reduce result transfers or retain results on GPU for later operations, only if semantics permit it.';
        default: return 'Hypothesis requires a separate benchmark.';
    }
}

export function cudaPhaseSamples(samples: CudaMetricSample[]): ProfilePhaseSample[] {
    return samples.filter(sample => sample.backend === 'CUDA' && measuredPhases.includes(sample.phase as (typeof measuredPhases)[number]))
        .map(sample => ({ phase: sample.phase as ProfilePhase, size: sample.size, sample: sample.sample, milliseconds: sample.milliseconds }));
}
