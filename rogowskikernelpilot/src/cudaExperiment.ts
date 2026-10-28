import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

export interface CudaKernelSignature {
    name: string;
    declaration: string;
    parameters: string[];
    line: number;
}

export interface CudaSourceAnalysis {
    kernels: CudaKernelSignature[];
    evidence: string[];
    limitations: string[];
}

export function resolveCudaArchitecture(configured: string | undefined, gpuStatus: string): string | undefined {
    const override = configured?.trim();
    if (override) {
        if (!/^sm_\d{2,3}$/.test(override)) {throw new Error('kernelpilot.cudaArchitecture must use a value such as sm_80 or sm_100.');}
        return override;
    }
    const match = gpuStatus.match(/,\s*(\d{1,2})\.(\d{1,2}),/);
    return match ? `sm_${match[1]}${match[2]}` : undefined;
}

export interface OptimizationProposal {
    schema_version: 1;
    optimized_source: string;
    summary: string;
    changes: Array<{ title: string; rationale: string; evidence: string }>;
    correctness_notes: string;
    benchmark_plan: string;
    risks: string[];
}

export interface CudaExperimentManifest {
    schema_version: 1;
    id: string;
    created_at: string;
    original_file: string;
    original_sha256: string;
    original_source: 'original.cu';
    candidate_source: 'candidate.cu' | null;
    model?: { provider: string; model: string; endpoint_origin: string; timeout_ms: number; temperature: number; max_tokens: number; prompt_version: string };
    status: 'analysis_only' | 'proposal_ready' | 'proposal_rejected' | 'compile_failed' | 'compiled_unverified' | 'correctness_failed' | 'performance_regression' | 'accepted' | 'cannot_confirm';
    analysis: CudaSourceAnalysis;
    proposal?: OptimizationProposal;
    compile_arguments: string[];
    toolchain: { nvcc: string; gpu: string };
    compilation: { original: string; candidate: string };
    validation: { harness: string | null; status: string; details: string };
    benchmark: { status: string; median_speedup: number | null; details: string; cases?: Array<{ name: string; passed: boolean; original_median_ms: number; original_p95_ms: number; candidate_median_ms: number; candidate_p95_ms: number }> };
}

export function analyzeCudaSource(source: string): CudaSourceAnalysis {
    const kernels: CudaKernelSignature[] = [];
    const declarationPattern = /(?:__global__|__device__|__host__\s+__global__)\s+(?:[\w:<>,*&\s]+?)\s+([A-Za-z_]\w*)\s*\(/g;
    for (const match of source.matchAll(declarationPattern)) {
        const start = (match.index ?? 0) + match[0].lastIndexOf('(') + 1;
        const end = findMatchingParen(source, start - 1);
        if (end < 0) {continue;}
        const declaration = match[0].slice(0, match[0].lastIndexOf('(')).trim();
        kernels.push({
            name: match[1], declaration,
            parameters: splitParameters(source.slice(start, end)),
            line: source.slice(0, match.index ?? 0).split('\n').length
        });
    }
    const evidence: string[] = [];
    if (/\b(?:cudaMemcpy|cudaMemcpyAsync)\s*\(/.test(source)) {evidence.push('Host/device transfer calls are present; transfer volume and overlap need runtime measurement.');}
    if (/\b__shared__\b/.test(source)) {evidence.push('Shared memory is used; bank conflicts, synchronization, and occupancy need profiler evidence.');}
    if (/\batomic(?:Add|Sub|Exch|CAS|Min|Max|Or|And|Xor)\s*\(/.test(source)) {evidence.push('Atomic operations are present; contention and ordering may limit throughput.');}
    if (/\b(?:if|switch)\s*\(/.test(source)) {evidence.push('Control-flow branches are present; warp divergence depends on data uniformity at runtime.');}
    if (/\[[^\]]*\*\s*(?:blockIdx|threadIdx|blockDim)/.test(source)) {evidence.push('Indexed memory expressions were found; coalescing is a hypothesis requiring access-pattern and profiler validation.');}
    if (/\b(?:float|double)\b/.test(source)) {evidence.push('Floating-point operations are present; any changed arithmetic order requires explicit numerical tolerances.');}
    if (!kernels.length) {evidence.push('No CUDA kernel declaration was confidently recognized; manual inspection is required.');}
    return {
        kernels,
        evidence,
        limitations: [
            'This is lexical source inspection, not compiler AST analysis, register/occupancy measurement, or GPU profiling.',
            'Register counts, occupancy, bank conflicts, coalescing, and runtime transfer costs are unknown until measured with the target compiler/device and profiler.'
        ]
    };
}

export function parseOptimizationProposal(raw: string, originalSource: string): OptimizationProposal {
    let parsed: unknown;
    try {parsed = JSON.parse(raw);} catch {
        const fenced = raw.match(/^\s*```json\s*([\s\S]*?)\s*```\s*$/i);
        if (!fenced) {throw new Error('Model response is not a JSON object matching the optimization schema.');}
        try {parsed = JSON.parse(fenced[1]);} catch {throw new Error('Model response contains malformed JSON.');}
    }
    if (!parsed || typeof parsed !== 'object') {throw new Error('Model response must be a JSON object.');}
    const value = parsed as Partial<OptimizationProposal>;
    if (value.schema_version !== 1 || typeof value.optimized_source !== 'string' || !value.optimized_source.trim() ||
        value.optimized_source.length > 1_000_000 || value.optimized_source.includes('\0') ||
        typeof value.summary !== 'string' || value.summary.trim().length < 5 ||
        !Array.isArray(value.changes) || value.changes.length > 20 ||
        !value.changes.every(item => item && typeof item.title === 'string' && item.title.trim() &&
            typeof item.rationale === 'string' && item.rationale.trim() && typeof item.evidence === 'string' && item.evidence.trim()) ||
        typeof value.correctness_notes !== 'string' || !value.correctness_notes.trim() ||
        typeof value.benchmark_plan !== 'string' || !value.benchmark_plan.trim() ||
        !Array.isArray(value.risks) || !value.risks.every(item => typeof item === 'string')) {
        throw new Error('Model response failed optimization proposal schema validation.');
    }
    const unchanged = value.optimized_source.trim() === originalSource.trim();
    if (unchanged && value.changes.length !== 0) {
        throw new Error('Model returned unchanged source while claiming changes; proposal is internally inconsistent.');
    }
    const originalKernels = analyzeCudaSource(originalSource).kernels.filter(kernel => /^__global__/.test(kernel.declaration));
    const candidateKernels = analyzeCudaSource(value.optimized_source).kernels.filter(kernel => /^__global__/.test(kernel.declaration));
    if (originalKernels.length && originalKernels.some(kernel =>
        !candidateKernels.some(candidate => candidate.name === kernel.name && normalizeSignature(candidate) === normalizeSignature(kernel)))) {
        throw new Error('Candidate changed or removed a public __global__ kernel name/signature; this prototype requires the original kernel ABI to remain callable by an independent harness.');
    }
    return {
        schema_version: 1,
        optimized_source: value.optimized_source,
        summary: value.summary.trim().slice(0, 4000),
        changes: value.changes.slice(0, 20).map(item => ({
            title: item.title.trim().slice(0, 240), rationale: item.rationale.trim().slice(0, 1500), evidence: item.evidence.trim().slice(0, 1500)
        })),
        correctness_notes: value.correctness_notes.trim().slice(0, 4000),
        benchmark_plan: value.benchmark_plan.trim().slice(0, 4000),
        risks: value.risks.slice(0, 20).map(item => item.slice(0, 1000))
    };
}

export async function createCudaExperiment(
    workspaceRoot: string,
    originalFile: string,
    originalSource: string,
    analysis: CudaSourceAnalysis,
    toolchain: CudaExperimentManifest['toolchain']
): Promise<{ directory: string; manifest: CudaExperimentManifest }> {
    if (!path.isAbsolute(workspaceRoot) || !path.isAbsolute(originalFile)) {throw new Error('Experiment workspace and source paths must be absolute.');}
    if (!/\.cu$/i.test(originalFile)) {throw new Error('The CUDA optimization workflow accepts .cu files only.');}
    if (!originalSource.trim() || originalSource.length > 2_000_000) {throw new Error('CUDA source is empty or exceeds the 2 MB prototype limit.');}
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const directory = path.join(workspaceRoot, '.kernelpilot', 'experiments', id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(directory, 'original.cu'), originalSource, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const manifest: CudaExperimentManifest = {
        schema_version: 1, id, created_at: new Date().toISOString(), original_file: originalFile,
        original_sha256: createHash('sha256').update(originalSource).digest('hex'), original_source: 'original.cu',
        candidate_source: null, status: 'analysis_only', analysis, toolchain,
        compile_arguments: [],
        compilation: { original: 'not attempted', candidate: 'not attempted' },
        validation: { harness: null, status: 'not run', details: 'An independent user-owned validation harness is required.' },
        benchmark: { status: 'not run', median_speedup: null, details: 'No benchmark result exists yet.' }
    };
    await writeCudaExperimentManifest(directory, manifest);
    return { directory, manifest };
}

export async function writeCudaExperimentManifest(directory: string, manifest: CudaExperimentManifest): Promise<void> {
    await writeFile(path.join(directory, 'experiment.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export async function persistCudaProposal(
    directory: string,
    manifest: CudaExperimentManifest,
    originalSource: string,
    modelResponse: string
): Promise<OptimizationProposal> {
    const proposal = parseOptimizationProposal(modelResponse, originalSource);
    manifest.proposal = proposal;
    if (proposal.optimized_source.trim() === originalSource.trim()) {
        manifest.status = 'proposal_rejected';
        manifest.candidate_source = null;
    } else {
        await writeFile(path.join(directory, 'candidate.cu'), proposal.optimized_source, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        manifest.candidate_source = 'candidate.cu';
        manifest.status = 'proposal_ready';
    }
    await writeCudaExperimentManifest(directory, manifest);
    return proposal;
}

export function renderCudaExperimentReport(manifest: CudaExperimentManifest): string {
    const lines = [
        '# KernelPilot CUDA experiment', '', `- Experiment: ${manifest.id}`, `- Created: ${manifest.created_at}`,
        `- Original: ${manifest.original_file}`, `- Original SHA-256: ${manifest.original_sha256}`,
        `- Result state: ${manifest.status}`, `- CUDA compiler: ${manifest.toolchain.nvcc}`,
        `- GPU/driver: ${manifest.toolchain.gpu}`, `- Original compilation: ${manifest.compilation.original}`,
        `- Candidate compilation: ${manifest.compilation.candidate}`, `- Correctness: ${manifest.validation.status}`,
        `- Model: ${manifest.model ? `${manifest.model.provider} / ${manifest.model.model} via ${manifest.model.endpoint_origin} (endpoint path intentionally omitted; timeout ${manifest.model.timeout_ms} ms, temperature ${manifest.model.temperature}, max tokens ${manifest.model.max_tokens}, prompt ${manifest.model.prompt_version})` : 'not contacted'}`,
        `- Compiler arguments: ${manifest.compile_arguments.join(' ') || 'none'}`,
        `- Validation harness: ${manifest.validation.harness ?? 'not configured'}`,
        `- Benchmark: ${manifest.benchmark.status}`,
        `- Median speedup: ${manifest.benchmark.median_speedup === null ? 'not measured' : `${manifest.benchmark.median_speedup.toFixed(3)}x`}`,
        '', '## Evidence and limitations', '', `- Static analysis: ${manifest.analysis.evidence.join(' ') || 'No lexical signal identified.'}`,
        `- Validation details: ${manifest.validation.details}`, `- Benchmark details: ${manifest.benchmark.details}`,
        `- Compiler diagnostics: original: ${manifest.compilation.original}; candidate: ${manifest.compilation.candidate}`,
        '- The harness is user supplied and controls the reference, correctness records, and measurement scope.',
        '- Compiler execution is not filesystem/network sandboxed. Candidate runtime isolation is recorded in the experiment output.',
        '- A compile-only result does not establish mathematical correctness or GPU performance.'
    ];
    if (manifest.benchmark.cases?.length) {
        lines.push('', '## Per-case measurements', '', '| Case | Correct | Original median (ms) | Original p95 (ms) | Candidate median (ms) | Candidate p95 (ms) |', '|---|---:|---:|---:|---:|---:|');
        for (const item of manifest.benchmark.cases) {
            lines.push(`| ${item.name} | ${item.passed ? 'PASS' : 'FAIL'} | ${item.original_median_ms} | ${item.original_p95_ms} | ${item.candidate_median_ms} | ${item.candidate_p95_ms} |`);
        }
    }
    if (manifest.proposal) {
        lines.push('', '## Model proposal', '', manifest.proposal.summary, '', '### Changes');
        for (const change of manifest.proposal.changes) {lines.push('', `#### ${change.title}`, change.rationale, `Evidence: ${change.evidence}`);}
        lines.push('', '### Correctness considerations', '', manifest.proposal.correctness_notes, '', '### Benchmark plan', '', manifest.proposal.benchmark_plan, '', '### Risks');
        for (const risk of manifest.proposal.risks) {lines.push(`- ${risk}`);}
    }
    return `${lines.join('\n')}\n`;
}

function findMatchingParen(source: string, open: number): number {
    let depth = 0;
    for (let index = open; index < source.length; index++) {
        if (source[index] === '(') {depth++;}
        if (source[index] === ')' && --depth === 0) {return index;}
    }
    return -1;
}

function splitParameters(value: string): string[] {
    const parts: string[] = [];
    let start = 0; let paren = 0; let angle = 0; let bracket = 0;
    for (let index = 0; index < value.length; index++) {
        const char = value[index];
        if (char === '(') {paren++;} else if (char === ')') {paren--;}
        else if (char === '<') {angle++;} else if (char === '>') {angle = Math.max(0, angle - 1);}
        else if (char === '[') {bracket++;} else if (char === ']') {bracket--;}
        else if (char === ',' && !paren && !angle && !bracket) {parts.push(value.slice(start, index).trim()); start = index + 1;}
    }
    const tail = value.slice(start).trim();
    if (tail && tail !== 'void') {parts.push(tail);}
    return parts;
}

function normalizeSignature(kernel: CudaKernelSignature): string {
    return `${kernel.name}(${kernel.parameters.join(',').replace(/\s+/g, ' ').trim()})`;
}
