export type CudaMetricBackend = 'CPU' | 'CUDA';
export type CudaMetricPhase = 'compute' | 'h2d' | 'kernel' | 'd2h' | 'end_to_end';

export interface CudaMetricSample {
    backend: CudaMetricBackend;
    phase: CudaMetricPhase;
    size: number;
    sample: number;
    milliseconds: number;
}

export interface CudaVerificationResult {
    size: number;
    checksum: number;
}

export function parseCudaVerificationResults(stdout: string): CudaVerificationResult[] {
    const results = new Map<number, number>();
    for (const line of stdout.split(/\r?\n/)) {
        const match = line.trim().match(/^KP_VERIFY_RESULT,(\d+),PASS,([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)$/i);
        if (match) {
            const size = Number(match[1]);
            const checksum = Number(match[2]);
            if (!Number.isSafeInteger(size) || size <= 0 || !Number.isFinite(checksum) || results.has(size)) {
                throw new Error(`Invalid CUDA correctness record: ${line.trim()}`);
            }
            results.set(size, checksum);
        } else if (line.trim().startsWith('KP_VERIFY_RESULT,')) {
            throw new Error(`Invalid CUDA correctness record: ${line.trim()}`);
        }
    }
    if (results.size !== 3) {
        throw new Error('CUDA execution did not provide three per-size correctness records');
    }
    return [...results.entries()].sort((a, b) => a[0] - b[0]).map(([size, checksum]) => ({ size, checksum }));
}

export function validateCudaRunOutput(stdout: string): number[] {
    const devices = stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith('KP_DEVICE,'));
    if (devices.length !== 1 || !/^KP_DEVICE,OK,([1-9]\d*)$/.test(devices[0])) {
        throw new Error('CUDA runtime did not confirm a usable device with KP_DEVICE,OK,<count>');
    }
    const results = parseCudaVerificationResults(stdout);
    if (!/^KP_VERIFY,OK$/m.test(stdout)) {
        throw new Error('CUDA execution did not confirm KP_VERIFY,OK');
    }
    return results.map(result => result.size);
}

const phases: CudaMetricPhase[] = ['compute', 'h2d', 'kernel', 'd2h', 'end_to_end'];

/** Parse the phase protocol and reject partial, duplicate, or non-positive sample sets. */
export function parseCudaMetricSamples(stdout: string, expectedSampleCount = 5): CudaMetricSample[] {
    if (!Number.isSafeInteger(expectedSampleCount) || expectedSampleCount < 1) {
        throw new Error('Expected metric sample count must be a positive integer');
    }
    const samples: CudaMetricSample[] = [];
    const seen = new Set<string>();
    const linePattern = /^KP_METRIC,(CPU|CUDA),(compute|h2d|kernel|d2h|end_to_end),(\d+),(\d+),([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)$/i;
    for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('KP_METRIC,')) {
            continue;
        }
        const match = trimmed.match(linePattern);
        if (!match) {
            throw new Error(`Invalid CUDA metric record: ${trimmed}`);
        }
        const backend = match[1].toUpperCase() as CudaMetricBackend;
        const phase = match[2].toLowerCase() as CudaMetricPhase;
        const size = Number(match[3]);
        const sample = Number(match[4]);
        const milliseconds = Number(match[5]);
        if (!Number.isSafeInteger(size) || size <= 0 || !Number.isSafeInteger(sample) || sample < 0 ||
            !Number.isFinite(milliseconds) || milliseconds <= 0) {
            throw new Error(`Invalid CUDA metric value: ${trimmed}`);
        }
        if ((backend === 'CPU' && !['compute', 'end_to_end'].includes(phase)) ||
            (backend === 'CUDA' && !['h2d', 'kernel', 'd2h', 'end_to_end'].includes(phase))) {
            throw new Error(`Metric phase ${phase} is not valid for ${backend}`);
        }
        const key = `${backend}/${phase}/${size}/${sample}`;
        if (seen.has(key)) {
            throw new Error(`Duplicate CUDA metric record: ${key}`);
        }
        seen.add(key);
        samples.push({ backend, phase, size, sample, milliseconds });
    }
    if (!samples.length) {
        throw new Error('No KP_METRIC records were emitted');
    }

    const cudaSizes = [...new Set(samples.filter(item => item.backend === 'CUDA').map(item => item.size))].sort((a, b) => a - b);
    if (cudaSizes.length !== 3) {
        throw new Error('CUDA metric protocol requires exactly three workload sizes');
    }
    for (const size of cudaSizes) {
        for (const phase of phases.filter(item => item === 'h2d' || item === 'kernel' || item === 'd2h' || item === 'end_to_end')) {
            const keys = samples.filter(item => item.backend === 'CUDA' && item.phase === phase && item.size === size);
            if (keys.length !== expectedSampleCount || new Set(keys.map(item => item.sample)).size !== expectedSampleCount ||
                Array.from({ length: expectedSampleCount }, (_, index) => index).some(index => !keys.some(item => item.sample === index))) {
                throw new Error(`CUDA ${phase} metrics require sample ids 0–${expectedSampleCount - 1} for size ${size}`);
            }
        }
        const cpuEndToEnd = samples.filter(item => item.backend === 'CPU' && item.phase === 'end_to_end' && item.size === size);
        if (cpuEndToEnd.length !== expectedSampleCount || new Set(cpuEndToEnd.map(item => item.sample)).size !== expectedSampleCount ||
            Array.from({ length: expectedSampleCount }, (_, index) => index).some(index => !cpuEndToEnd.some(item => item.sample === index))) {
            throw new Error(`CPU end_to_end metrics require sample ids 0–${expectedSampleCount - 1} for size ${size}`);
        }
    }
    if (samples.some(item => item.backend === 'CPU' && item.phase === 'compute')) {
        for (const size of cudaSizes) {
            const cpuCompute = samples.filter(item => item.backend === 'CPU' && item.phase === 'compute' && item.size === size);
            if (cpuCompute.length !== expectedSampleCount || new Set(cpuCompute.map(item => item.sample)).size !== expectedSampleCount ||
                Array.from({ length: expectedSampleCount }, (_, index) => index).some(index => !cpuCompute.some(item => item.sample === index))) {
                throw new Error(`CPU compute metrics require sample ids 0–${expectedSampleCount - 1} for size ${size}`);
            }
        }
    }
    return samples;
}

export function getCudaMetricSamples(samples: CudaMetricSample[], backend: CudaMetricBackend, phase: CudaMetricPhase): Array<{size: number; sample: number; milliseconds: number}> {
    return samples.filter(item => item.backend === backend && item.phase === phase)
        .map(({ size, sample, milliseconds }) => ({ size, sample, milliseconds }));
}
