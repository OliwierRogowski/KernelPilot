export interface GpuBackendDecision {
    task: 'cuda_backend_selection';
    schema_version: 1;
    decision: 'cpu_only' | 'benchmark_cuda';
    confidence: number;
    reason: string;
}

export interface RecordedGpuBackendDecision extends GpuBackendDecision {
    source: 'model' | 'fallback' | 'unsupported';
    model: string;
    modelDecision?: GpuBackendDecision;
}

export interface BenchmarkAdapter {
    task: 'cpu_benchmark_adapter';
    schema_version: 1;
    workload_sizes: [number, number, number];
    adapter: string;
}

export function recordUserRequestedCudaAttempt(modelDecision: GpuBackendDecision, model: string): RecordedGpuBackendDecision {
    return {
        ...modelDecision,
        decision: 'benchmark_cuda',
        confidence: 0,
        reason: `User-requested benchmark: CUDA validation is attempted; model recommendation: ${modelDecision.decision} (${modelDecision.reason}). This does not imply a speedup.`,
        source: 'fallback',
        model,
        modelDecision
    };
}

export function unavailableCudaComparison(status: string): string {
    return `CPU/CUDA comparison is unresolved because no actual CUDA samples were collected. Cause: ${status}. There is no evidence to establish CPU or GPU superiority. Suggestions such as par_unseq or parallel initialization are hypotheses that require separate measurements.`;
}

export function parseGpuBackendDecision(response: string): GpuBackendDecision | undefined {
    const json = response.match(/\{[\s\S]*\}/)?.[0];
    if (!json) {
        return undefined;
    }
    try {
        const value = JSON.parse(json) as Partial<GpuBackendDecision>;
        if (value.task !== 'cuda_backend_selection' || value.schema_version !== 1 ||
            (value.decision !== 'cpu_only' && value.decision !== 'benchmark_cuda') ||
            typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) ||
            value.confidence < 0 || value.confidence > 1 ||
            typeof value.reason !== 'string' || value.reason.trim().length === 0) {
            return undefined;
        }
        return {
            task: 'cuda_backend_selection',
            schema_version: 1,
            decision: value.decision,
            confidence: value.confidence,
            reason: value.reason.trim().slice(0, 500)
        };
    } catch {
        return undefined;
    }
}

export function parseBenchmarkAdapter(response: string): BenchmarkAdapter | undefined {
    try {
        const value = JSON.parse(response) as Partial<BenchmarkAdapter>;
        if (value.task !== 'cpu_benchmark_adapter' || value.schema_version !== 1 ||
            !Array.isArray(value.workload_sizes) || value.workload_sizes.length !== 3 ||
            !value.workload_sizes.every(size => Number.isSafeInteger(size) && size > 0 && size <= 1_000_000_000) ||
            !(value.workload_sizes[0] < value.workload_sizes[1] && value.workload_sizes[1] < value.workload_sizes[2]) ||
            typeof value.adapter !== 'string' || value.adapter.trim().length === 0) {
            return undefined;
        }
        return {
            task: 'cpu_benchmark_adapter',
            schema_version: 1,
            workload_sizes: value.workload_sizes as [number, number, number],
            adapter: value.adapter.trim()
        };
    } catch {
        return undefined;
    }
}
