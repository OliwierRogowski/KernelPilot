export interface TimingPoint { size: number; milliseconds: number; sample?: number; }
export interface TimingSummary { size: number; medianMs: number; minMs: number; maxMs: number; sampleCount: number; }

interface PairedResult { cudaWins: number; cpuWins: number; ties: number; pValue?: number; }

function pairedSignTest(pairs: Array<{ cpu: number; cuda: number }>): PairedResult {
    let cudaWins = 0; let cpuWins = 0; let ties = 0;
    for (const pair of pairs) {
        if (pair.cuda < pair.cpu) {cudaWins++;}
        else if (pair.cuda > pair.cpu) {cpuWins++;}
        else {ties++;}
    }
    const decisive = cudaWins + cpuWins;
    if (!decisive) {return { cudaWins, cpuWins, ties };}
    const tail = Math.min(cudaWins, cpuWins);
    let combinations = 1; let tailSum = 1;
    for (let k = 1; k <= tail; k++) {
        combinations *= (decisive - k + 1) / k;
        tailSum += combinations;
    }
    return { cudaWins, cpuWins, ties, pValue: Math.min(1, 2 * tailSum / (2 ** decisive)) };
}

export function summarizeTimings(samples: TimingPoint[]): TimingSummary[] {
    const groups = new Map<number, number[]>();
    for (const sample of samples) {
        const values = groups.get(sample.size) ?? [];
        values.push(sample.milliseconds);
        groups.set(sample.size, values);
    }
    return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([size, values]) => {
        const ordered = [...values].sort((a, b) => a - b);
        const middle = Math.floor(ordered.length / 2);
        return { size, medianMs: ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2,
            minMs: ordered[0], maxMs: ordered[ordered.length - 1], sampleCount: ordered.length };
    });
}

function pairsBySizeAndId(cpu: TimingPoint[], cuda: TimingPoint[]): Map<number, Array<{ cpu: number; cuda: number }>> {
    const cpuMap = new Map<string, TimingPoint>(); const cudaMap = new Map<string, TimingPoint>();
    for (const point of cpu) {if (point.sample !== undefined) {cpuMap.set(`${point.size}/${point.sample}`, point);}}
    for (const point of cuda) {if (point.sample !== undefined) {cudaMap.set(`${point.size}/${point.sample}`, point);}}
    const pairs = new Map<number, Array<{ cpu: number; cuda: number }>>();
    for (const [key, cpuPoint] of cpuMap) {
        const cudaPoint = cudaMap.get(key);
        if (!cudaPoint) {continue;}
        const atSize = pairs.get(cpuPoint.size) ?? [];
        atSize.push({ cpu: cpuPoint.milliseconds, cuda: cudaPoint.milliseconds });
        pairs.set(cpuPoint.size, atSize);
    }
    return pairs;
}

export function interpretMatchedTimings(cpu: TimingPoint[], cuda: TimingPoint[], phase: 'compute↔kernel' | 'end-to-end↔end-to-end'): string {
    const cpuGroups = summarizeTimings(cpu); const cudaGroups = summarizeTimings(cuda);
    const pairsMap = pairsBySizeAndId(cpu, cuda);
    const matched = cpuGroups.map(cpuSummary => ({ cpu: cpuSummary,
        cuda: cudaGroups.find(group => group.size === cpuSummary.size), pairs: pairsMap.get(cpuSummary.size) ?? [],
        unmatched: Math.max(cpu.filter(point => point.size === cpuSummary.size).length,
            cuda.filter(point => point.size === cpuSummary.size).length) - (pairsMap.get(cpuSummary.size)?.length ?? 0)
    })).filter((item): item is typeof item & { cuda: TimingSummary } => item.cuda !== undefined);
    if (!matched.length) {return `No matching samples for ${phase}; comparison is unresolved. Samples must share both input size and sample ID.`;}
    const lowerCudaMedianCount = matched.filter(({ cpu: c, cuda: g }) => g.medianMs < c.medianMs).length;
    const cudaSeparatedCount = matched.filter(({ cpu: c, cuda: g }) => g.maxMs < c.minMs).length;
    const results: PairedResult[] = matched.map(item => pairedSignTest(item.pairs));
    const significantCuda = results.filter(result => result.pValue !== undefined && result.pValue < 0.05 && result.cudaWins > result.cpuWins).length;
    const significantCpu = results.filter(result => result.pValue !== undefined && result.pValue < 0.05 && result.cpuWins > result.cudaWins).length;
    const lines = matched.map(({ cpu: c, cuda: g, pairs, unmatched }) => {
        const direction = g.medianMs < c.medianMs ? 'CUDA median is lower' : g.medianMs > c.medianMs ? 'CPU median is lower' : 'medians are equal';
        const ranges = g.maxMs < c.minMs || c.maxMs < g.minMs ? 'min–max ranges do not overlap' : 'min–max ranges overlap';
        const result = pairedSignTest(pairs);
        const test = result.pValue === undefined
            ? `${pairs.length} matched pairs; all are ties`
            : `CUDA: ${result.cudaWins}/${pairs.length} pairs; CPU: ${result.cpuWins}/${pairs.length}; ties: ${result.ties}; two-sided exact sign test p=${result.pValue.toFixed(4)}`;
        return `n=${c.size}: ${direction} (CPU: ${c.medianMs.toFixed(6)} ms; CUDA: ${g.medianMs.toFixed(6)} ms); ${ranges}; CPU samples=${c.sampleCount}, CUDA samples=${g.sampleCount}, matched pairs=${pairs.length}, unmatched=${unmatched}; ${test}.`;
    });
    const medianNote = lowerCudaMedianCount === matched.length ? 'CUDA median is lower at every measured size.'
        : lowerCudaMedianCount === 0 ? 'CUDA median is not lower at any measured size.'
            : `CUDA median is lower at ${lowerCudaMedianCount}/${matched.length} measured sizes.`;
    const rangeNote = `${cudaSeparatedCount}/${matched.length} sizes have non-overlapping min–max ranges favoring CUDA.`;
    const directionNote = significantCuda || significantCpu
        ? `Paired exact sign test at p<0.05 favors CUDA at ${significantCuda} sizes and CPU at ${significantCpu} sizes. This is scoped to the measured machine, input sizes, and timers.`
        : 'Median differences are descriptive; the paired sign test does not establish a stable advantage at p<0.05.';
    const incomplete = matched.some(item => item.unmatched > 0 || item.pairs.length < 5)
        ? 'Some pairs are missing or fewer than five matched observations are available; do not infer a stable advantage.' : '';
    return [...lines, medianNote, rangeNote, directionNote, incomplete,
        'These measurements do not establish a CPU/CUDA crossover threshold; do not extrapolate beyond measured sizes.'].filter(Boolean).join('\n');
}

export function measuredBenchmarkRecommendation(cpuCompute: TimingPoint[], cudaKernel: TimingPoint[], cpuEndToEnd: TimingPoint[], cudaEndToEnd: TimingPoint[], cudaSamplesAvailable: boolean, cudaFailure: string): string {
    if (!cudaSamplesAvailable) {return `Measurement result: CPU/CUDA comparison is unresolved because no actual CUDA samples are available. Cause: ${cudaFailure || 'CUDA measurement did not complete'}. No advantage or threshold is claimed.\n\n${scenarioChangeHypotheses()}`;}
    return ['Measurement results (measured sizes only; no extrapolation):',
        `CPU compute ↔ CUDA kernel:\n${interpretMatchedTimings(cpuCompute, cudaKernel, 'compute↔kernel')}`,
        `CPU end-to-end ↔ CUDA end-to-end:\n${interpretMatchedTimings(cpuEndToEnd, cudaEndToEnd, 'end-to-end↔end-to-end')}`,
        `Other scenarios were not measured. ${scenarioChangeHypotheses()}`].join('\n\n');
}

export function scenarioChangeHypotheses(): string {
    return 'Separate unmeasured experiments: generate data on GPU and include equivalent CPU data-generation cost; retain data on-device across later operations only when program semantics permit (this may avoid repeated H2D); compare pageable and pinned transfers separately. The harness already uses pinned host buffers and still measures H2D. Inputs are prepared before timing samples; these results are not full source-program runtime.';
}
