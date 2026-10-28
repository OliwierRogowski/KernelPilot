import * as path from 'node:path';

export interface CudaLaunchSite {
    siteId: number;
    kernel: string;
    start: number;
    end: number;
    grid: string;
    block: string;
    shared: string;
    stream: string;
}

export interface CudaProfilePlan {
    kind: 'standalone' | 'translation-unit-required' | 'launch-parameters-required';
    kernelNames: string[];
    launchCount: number;
    reason: string;
}

export interface CudaKernelEventSample {
    run: number;
    kernel: string;
    siteId: number;
    invocation: number;
    grid: [number, number, number];
    block: [number, number, number];
    sharedBytes: number;
    stream: string;
    milliseconds: number;
}
export interface CudaCopyEventSample {
    run: number;
    direction: 'H2D' | 'D2H' | 'D2D' | 'H2H' | 'unknown';
    siteId: number;
    invocation: number;
    bytes: number;
    stream: string;
    milliseconds: number;
}
export interface CudaRuntimeSummary { kernelLaunches: number; asyncCopies: number; }

/** Identify whether the active CUDA source can be profiled as a program or needs its caller. */
export function planCudaSourceProfile(filePath: string, source: string, selectedSource = ''): CudaProfilePlan {
    const isHeader = /\.cuh$/i.test(filePath);
    const launches = findCudaLaunchSites(source);
    const selectedKernel = selectedSource.match(/\b__global__\s+(?:[\w:<>,*&\s]+?)\s+([A-Za-z_]\w*)\s*\(/)?.[1];
    const hasMain = /\b(?:int|auto)\s+main\s*\(/.test(source);
    const relevantLaunches = selectedKernel ? launches.filter(launch => launch.kernel === selectedKernel) : launches;
    if (isHeader || !hasMain) {
        return {
            kind: selectedKernel && !relevantLaunches.length ? 'launch-parameters-required' : 'translation-unit-required',
            kernelNames: selectedKernel ? [selectedKernel] : [...new Set(launches.map(launch => launch.kernel))],
            launchCount: relevantLaunches.length,
            reason: isHeader
                ? 'A .cuh header is not a translation unit and needs a project .cu caller.'
                : selectedKernel && !relevantLaunches.length
                    ? `Kernel ${selectedKernel} has no launch in the selected source; grid, block, arguments, and a calling translation unit are required.`
                    : 'This CUDA source has no main function; a project translation unit that calls the selected code is required.'
        };
    }
    if (!relevantLaunches.length) {
        return {
            kind: 'launch-parameters-required', kernelNames: selectedKernel ? [selectedKernel] : [], launchCount: 0,
            reason: selectedKernel
                ? `Kernel ${selectedKernel} is declared but no launch configuration was found.`
                : 'No CUDA kernel launch was found in the standalone program.'
        };
    }
    return {
        kind: 'standalone', kernelNames: [...new Set(relevantLaunches.map(launch => launch.kernel))],
        launchCount: relevantLaunches.length,
        reason: `Standalone CUDA program with ${relevantLaunches.length} original kernel launch site(s).`
    };
}

/**
 * Add asynchronous CUDA event pairs around source launch expressions. Events are
 * recorded on each launch's own stream and are synchronized only after main exits,
 * so overlapping streams remain concurrent during the measured program run.
 */
export function instrumentCudaKernelLaunches(source: string, selectedKernel?: string | string[]): { source: string; launchSites: CudaLaunchSite[] } {
    const selected = selectedKernel ? new Set(Array.isArray(selectedKernel) ? selectedKernel : [selectedKernel]) : undefined;
    const launchSites = findCudaLaunchSites(source).filter(site => !selected || selected.has(site.kernel));
    if (!launchSites.length) {throw new Error(selectedKernel ? `No launch call for ${selectedKernel} was found.` : 'No CUDA kernel launch expressions were found.');}
    let instrumented = source;
    for (const site of [...launchSites].reverse()) {
        const original = source.slice(site.start, site.end);
        const wrapped = `{ const dim3 kp_grid(${site.grid}); const dim3 kp_block(${site.block}); const std::size_t kp_shared = static_cast<std::size_t>(${site.shared}); const cudaStream_t kp_stream = ${site.stream}; kernelpilotRecordLaunch(${site.siteId}, "${site.kernel}", kp_grid, kp_block, kp_shared, kp_stream, [&]() { ${original} }); }`;
        instrumented = instrumented.slice(0, site.start) + wrapped + instrumented.slice(site.end);
    }
    return { source: instrumented, launchSites };
}

export function buildCudaEventProfilerTranslationUnit(source: string, selectedKernel?: string | string[]): { translationUnit: string; launchSites: CudaLaunchSite[]; copySites: number } {
    if (!/\bint\s+main\s*\(/.test(source)) {
        throw new Error('CUDA profiling requires a translation unit with a main function.');
    }
    const instrumented = instrumentCudaOperations(source, selectedKernel);
    const include = `
#include <cuda_runtime.h>
#include <cmath>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <exception>
#include <functional>
#include <stdexcept>
#include <string>
#include <vector>
struct KernelPilotLaunchRecord { unsigned int site; std::size_t invocation; const char* kernel; dim3 grid; dim3 block; std::size_t shared; cudaStream_t stream; cudaEvent_t start; cudaEvent_t stop; };
struct KernelPilotCopyRecord { unsigned int site; std::size_t invocation; cudaMemcpyKind kind; std::size_t bytes; cudaStream_t stream; cudaEvent_t start; cudaEvent_t stop; };
static std::vector<KernelPilotLaunchRecord> kernelpilot_launch_records;
static std::vector<KernelPilotCopyRecord> kernelpilot_copy_records;
static std::size_t kernelpilot_next_launch_invocation = 0;
static std::size_t kernelpilot_next_copy_invocation = 0;
static void kernelpilotFlushLaunches();
static std::string kernelpilot_cuda_stream_name(cudaStream_t stream) { return stream == nullptr ? "default" : "non-default"; }
static void kernelpilot_cuda_check(cudaError_t error, const char* operation) { if (error != cudaSuccess) throw std::runtime_error(std::string(operation) + ": " + cudaGetErrorString(error)); }
template<class Launch> static void kernelpilotRecordLaunch(unsigned int site, const char* name, dim3 grid, dim3 block, std::size_t shared, cudaStream_t stream, Launch launch) {
    KernelPilotLaunchRecord record{site, kernelpilot_next_launch_invocation++, name, grid, block, shared, stream, nullptr, nullptr};
    try { kernelpilot_cuda_check(cudaEventCreate(&record.start), "cudaEventCreate(start)"); }
    catch (const std::exception& error) { throw std::runtime_error(std::string("launch site ") + std::to_string(site) + " (" + name + "), event setup: " + error.what()); }
    try {
        try { kernelpilot_cuda_check(cudaEventCreate(&record.stop), "cudaEventCreate(stop)"); }
        catch (const std::exception& error) { throw std::runtime_error(std::string("launch site ") + std::to_string(site) + " (" + name + "), event setup: " + error.what()); }
        try { kernelpilot_cuda_check(cudaEventRecord(record.start, stream), "cudaEventRecord(start)"); }
        catch (const std::exception& error) { throw std::runtime_error(std::string("launch site ") + std::to_string(site) + " (" + name + "), event start record: " + error.what()); }
        launch();
        try { kernelpilot_cuda_check(cudaGetLastError(), "kernel launch"); }
        catch (const std::exception& error) { throw std::runtime_error(std::string("launch site ") + std::to_string(site) + " (" + name + "), launch: " + error.what()); }
        try { kernelpilot_cuda_check(cudaEventRecord(record.stop, stream), "cudaEventRecord(stop)"); }
        catch (const std::exception& error) { throw std::runtime_error(std::string("launch site ") + std::to_string(site) + " (" + name + "), event stop record: " + error.what()); }
        kernelpilot_launch_records.push_back(record);
    } catch (...) { if (record.stop) cudaEventDestroy(record.stop); cudaEventDestroy(record.start); throw; }
}
template<class Copy> static cudaError_t kernelpilotRecordAsyncCopy(unsigned int site, const void* destination, const void* source, std::size_t bytes, cudaMemcpyKind kind, cudaStream_t stream, Copy copy) {
    KernelPilotCopyRecord record{site, kernelpilot_next_copy_invocation++, kind, bytes, stream, nullptr, nullptr};
    kernelpilot_cuda_check(cudaEventCreate(&record.start), "cudaEventCreate(copy start)");
    try {
        kernelpilot_cuda_check(cudaEventCreate(&record.stop), "cudaEventCreate(copy stop)");
        kernelpilot_cuda_check(cudaEventRecord(record.start, stream), "cudaEventRecord(copy start)");
        const cudaError_t status = copy();
        if (status != cudaSuccess) { cudaEventDestroy(record.stop); cudaEventDestroy(record.start); return status; }
        kernelpilot_cuda_check(cudaEventRecord(record.stop, stream), "cudaEventRecord(copy stop)");
        kernelpilot_copy_records.push_back(record);
        (void)destination; (void)source;
        return status;
    } catch (...) { if (record.stop) cudaEventDestroy(record.stop); cudaEventDestroy(record.start); throw; }
}
`;
    const mainMatch = /\bint\s+main\s*\(/.exec(source);
    const mainOpen = mainMatch ? source.indexOf('(', mainMatch.index) : -1;
    const mainClose = mainOpen >= 0 ? findMatchingDelimiter(source, mainOpen, '(', ')') : -1;
    const mainParameters = mainOpen >= 0 && mainClose >= 0 ? splitTopLevel(source.slice(mainOpen + 1, mainClose)).filter(Boolean) : [];
    const argcMain = mainParameters.length === 2 && /^\s*int\b/.test(mainParameters[0]) && /\bchar\s*\*\s*(?:\*\s*[A-Za-z_]\w*|[A-Za-z_]\w*\s*\[\s*\])/.test(mainParameters[1]);
    if (mainParameters.length > 0 && !(mainParameters.length === 1 && /^\s*void\s*$/.test(mainParameters[0])) && !argcMain) {
        throw new Error('The existing CUDA program main must be int main() or int main(int, char**); other entry signatures need a user-provided wrapper.');
    }
    const renamed = instrumented.source.replace(/\bint\s+main\s*\(/, 'int kernelpilot_original_main(');
    const wrapper = argcMain
        ? `\nint main(int argc, char** argv) { try { return kernelpilotRunOriginalMain(kernelpilot_original_main, argc, argv); } catch (const std::exception& error) { std::fprintf(stderr, "CUDA profile failed: %s\\n", error.what()); return 2; } }\n`
        : `\nint main() { try { return kernelpilotRunOriginalMain(kernelpilot_original_main); } catch (const std::exception& error) { std::fprintf(stderr, "CUDA profile failed: %s\\n", error.what()); return 2; } }\n`;
    const mainRunner = argcMain
        ? `static int kernelpilotRunOriginalMain(int (*originalMain)(int, char**), int argc, char** argv) { const int result = originalMain(argc, argv); kernelpilotFlushLaunches(); return result; }`
        : `static int kernelpilotRunOriginalMain(int (*originalMain)()) { const int result = originalMain(); kernelpilotFlushLaunches(); return result; }`;
    const flush = `static void kernelpilotFlushLaunches() {
    for (std::size_t index = 0; index < kernelpilot_launch_records.size(); ++index) {
        auto& record = kernelpilot_launch_records[index];
        try { kernelpilot_cuda_check(cudaEventSynchronize(record.stop), "cudaEventSynchronize(profile flush)"); }
        catch (const std::exception& error) { throw std::runtime_error(std::string("launch site ") + std::to_string(record.site) + " (" + record.kernel + "), finalization sync: " + error.what()); }
        float milliseconds = 0.0f;
        try { kernelpilot_cuda_check(cudaEventElapsedTime(&milliseconds, record.start, record.stop), "cudaEventElapsedTime"); }
        catch (const std::exception& error) { throw std::runtime_error(std::string("launch site ") + std::to_string(record.site) + " (" + record.kernel + "), elapsed-time read: " + error.what()); }
        std::printf("KP_PROFILE_KERNEL,%s,%u,%zu,%u,%u,%u,%u,%u,%u,%zu,%s,%.9f\\n", record.kernel, record.site, record.invocation,
            record.grid.x, record.grid.y, record.grid.z, record.block.x, record.block.y, record.block.z,
            record.shared, kernelpilot_cuda_stream_name(record.stream).c_str(), milliseconds);
        cudaEventDestroy(record.stop); cudaEventDestroy(record.start);
    }
    for (std::size_t index = 0; index < kernelpilot_copy_records.size(); ++index) {
        auto& record = kernelpilot_copy_records[index];
        kernelpilot_cuda_check(cudaEventSynchronize(record.stop), "cudaEventSynchronize(copy profile flush)");
        float milliseconds = 0.0f;
        kernelpilot_cuda_check(cudaEventElapsedTime(&milliseconds, record.start, record.stop), "cudaEventElapsedTime(copy)");
        const char* direction = record.kind == cudaMemcpyHostToDevice ? "H2D" : record.kind == cudaMemcpyDeviceToHost ? "D2H" :
            record.kind == cudaMemcpyDeviceToDevice ? "D2D" : record.kind == cudaMemcpyHostToHost ? "H2H" : "unknown";
        std::printf("KP_PROFILE_COPY,%s,%u,%zu,%zu,%s,%.9f\\n", direction, record.site, record.invocation, record.bytes,
            kernelpilot_cuda_stream_name(record.stream).c_str(), milliseconds);
        cudaEventDestroy(record.stop); cudaEventDestroy(record.start);
    }
    std::printf("KP_PROFILE_RUN,%zu,%zu\\n", kernelpilot_launch_records.size(), kernelpilot_copy_records.size());
    std::fflush(stdout);
    kernelpilot_launch_records.clear();
    kernelpilot_copy_records.clear();
}`;
    return { translationUnit: `${include}\n${renamed}\n${flush}\n${mainRunner}\n${wrapper}`, launchSites: instrumented.launchSites, copySites: instrumented.copySites };
}

export function parseCudaKernelEventSamples(output: string): CudaKernelEventSample[] {
    const samples: CudaKernelEventSample[] = [];
    for (const line of output.split(/\r?\n/)) {
        if (!line.startsWith('KP_PROFILE_KERNEL,')) {continue;}
        const match = line.match(/^KP_PROFILE_KERNEL,([A-Za-z_]\w*),(\d+),(\d+),(\d+),(\d+),(\d+),(\d+),(\d+),(\d+),(\d+),([^,]+),([\d.eE+-]+)$/);
        if (!match) {throw new Error(`Invalid CUDA kernel profile record: ${line}`);}
        const siteId = Number(match[2]);
        const values = match.slice(3, 11).map(Number);
        const milliseconds = Number(match[12]);
        if (values.some(value => !Number.isSafeInteger(value) || value < 0) || !Number.isFinite(milliseconds) || milliseconds <= 0) {
            throw new Error(`Invalid CUDA kernel profile value: ${line}`);
        }
        samples.push({
            run: 0, kernel: match[1], siteId, invocation: values[0], grid: [values[1], values[2], values[3]],
            block: [values[4], values[5], values[6]], sharedBytes: values[7], stream: match[11], milliseconds
        });
    }
    return samples;
}

export function parseCudaCopyEventSamples(output: string): CudaCopyEventSample[] {
    const samples: CudaCopyEventSample[] = [];
    for (const line of output.split(/\r?\n/)) {
        if (!line.startsWith('KP_PROFILE_COPY,')) {continue;}
        const match = line.match(/^KP_PROFILE_COPY,(H2D|D2H|D2D|H2H|unknown),(\d+),(\d+),(\d+),([^,]+),([\d.eE+-]+)$/);
        if (!match) {throw new Error(`Invalid CUDA copy profile record: ${line}`);}
        const siteId = Number(match[2]); const invocation = Number(match[3]); const bytes = Number(match[4]); const milliseconds = Number(match[6]);
        if (![siteId, invocation, bytes].every(value => Number.isSafeInteger(value) && value >= 0) || !Number.isFinite(milliseconds) || milliseconds <= 0) {
            throw new Error(`Invalid CUDA copy profile value: ${line}`);
        }
        samples.push({ run: 0, direction: match[1] as CudaCopyEventSample['direction'], siteId, invocation, bytes, stream: match[5], milliseconds });
    }
    return samples;
}

/** The final marker proves the wrapper finalizer ran, including when no launch was reached. */
export function parseCudaRuntimeSummaries(output: string): CudaRuntimeSummary[] {
    const summaries: CudaRuntimeSummary[] = [];
    for (const line of output.split(/\r?\n/)) {
        if (!line.startsWith('KP_PROFILE_RUN,')) {continue;}
        const match = line.match(/^KP_PROFILE_RUN,(\d+),(\d+)$/);
        if (!match) {throw new Error(`Invalid CUDA profile finalization record: ${line}`);}
        const values = match.slice(1).map(Number);
        if (values.some(value => !Number.isSafeInteger(value) || value < 0)) {throw new Error(`Invalid CUDA profile finalization values: ${line}`);}
        summaries.push({ kernelLaunches: values[0], asyncCopies: values[1] });
    }
    return summaries;
}

/** Parse a CUDA launch statement using balanced delimiters; unsupported expressions are rejected. */
export function findCudaLaunchSites(source: string): CudaLaunchSite[] {
    const sites: CudaLaunchSite[] = [];
    const marker = /<<<(?!<)/g;
    for (let match = marker.exec(source); match; match = marker.exec(source)) {
        const configEnd = source.indexOf('>>>', marker.lastIndex);
        if (configEnd < 0) {continue;}
        const config = splitTopLevel(source.slice(marker.lastIndex, configEnd));
        if (config.length < 2 || config.length > 4) {continue;}
        const prefix = source.slice(Math.max(0, match.index - 240), match.index);
        const calleeMatch = prefix.match(/((?:[A-Za-z_]\w*\s*::\s*)*[A-Za-z_]\w*)\s*$/);
        if (!calleeMatch) {continue;}
        const kernel = calleeMatch[1].replace(/\s+/g, '');
        if (!/^[A-Za-z_]\w*(?:::\w+)*$/.test(kernel)) {continue;}
        const callOpen = skipSpaces(source, configEnd + 3);
        if (source[callOpen] !== '(') {continue;}
        const callEnd = findMatchingDelimiter(source, callOpen, '(', ')');
        if (callEnd < 0) {continue;}
        const statementEnd = skipSpaces(source, callEnd + 1);
        if (source[statementEnd] !== ';') {continue;}
        const args = source.slice(calleeMatch.index === undefined ? match.index : match.index - prefix.length + calleeMatch.index, statementEnd + 1);
        if (/[{}]/.test(args)) {continue;}
        sites.push({
            siteId: sites.length, kernel, start: match.index - prefix.length + (calleeMatch.index ?? 0), end: statementEnd + 1,
            grid: config[0], block: config[1], shared: config[2] ?? '0', stream: config[3] ?? 'nullptr'
        });
        marker.lastIndex = statementEnd + 1;
    }
    return sites;
}

export function instrumentCudaOperations(source: string, selectedKernel?: string | string[]): { source: string; launchSites: CudaLaunchSite[]; copySites: number } {
    const launched = instrumentCudaKernelLaunches(source, selectedKernel);
    const edits: Array<{ start: number; end: number; replacement: string }> = launched.launchSites.map(site => ({
        start: site.start, end: site.end,
        replacement: `{ const dim3 kp_grid(${site.grid}); const dim3 kp_block(${site.block}); const std::size_t kp_shared = static_cast<std::size_t>(${site.shared}); const cudaStream_t kp_stream = ${site.stream}; kernelpilotRecordLaunch(${site.siteId}, "${site.kernel}", kp_grid, kp_block, kp_shared, kp_stream, [&]() { ${source.slice(site.start, site.end)} }); }`
    }));
    const resetPattern = /\bcudaDeviceReset\s*\(\s*\)/g;
    for (let match = resetPattern.exec(source); match; match = resetPattern.exec(source)) {
        const open = source.indexOf('(', match.index);
        const close = source.indexOf(')', open);
        if (close < 0 || edits.some(edit => match!.index >= edit.start && match!.index < edit.end)) {continue;}
        edits.push({ start: match.index, end: close + 1, replacement: '([&]() { kernelpilotFlushLaunches(); return cudaDeviceReset(); }())' });
    }
    const copyPattern = /\bcudaMemcpyAsync\s*\(/g;
    let copySiteId = 0;
    for (let match = selectedKernel ? null : copyPattern.exec(source); match; match = copyPattern.exec(source)) {
        const open = source.indexOf('(', match.index);
        const close = findMatchingDelimiter(source, open, '(', ')');
        if (close < 0) {continue;}
        const args = splitTopLevel(source.slice(open + 1, close));
        if (args.length < 4 || args.length > 5 || edits.some(edit => match!.index >= edit.start && match!.index < edit.end)) {continue;}
        const [destination, from, bytes, kind, stream = 'nullptr'] = args;
        const replacement = `([&]() { auto kp_copy_destination = (${destination}); auto kp_copy_source = (${from}); const std::size_t kp_copy_bytes = static_cast<std::size_t>(${bytes}); const cudaMemcpyKind kp_copy_kind = (${kind}); const cudaStream_t kp_copy_stream = (${stream}); return kernelpilotRecordAsyncCopy(${copySiteId++}, kp_copy_destination, kp_copy_source, kp_copy_bytes, kp_copy_kind, kp_copy_stream, [&]() { return cudaMemcpyAsync(kp_copy_destination, kp_copy_source, kp_copy_bytes, kp_copy_kind, kp_copy_stream); }); }())`;
        edits.push({ start: match.index, end: close + 1, replacement });
        copyPattern.lastIndex = close + 1;
    }
    let transformed = source;
    for (const edit of edits.sort((a, b) => b.start - a.start)) {transformed = transformed.slice(0, edit.start) + edit.replacement + transformed.slice(edit.end);}
    return { source: transformed, launchSites: launched.launchSites, copySites: edits.filter(edit => !launched.launchSites.some(site => site.start === edit.start)).length };
}

function splitTopLevel(value: string): string[] {
    const parts: string[] = []; let start = 0; const stack: string[] = []; let quote = '';
    const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}', '<': '>' };
    for (let index = 0; index < value.length; index++) {
        const char = value[index];
        if (quote) { if (char === quote && value[index - 1] !== '\\') {quote = '';} continue; }
        if (char === '"' || char === "'") {quote = char; continue;}
        if (pairs[char]) {stack.push(pairs[char]); continue;}
        if (char === stack[stack.length - 1]) {stack.pop(); continue;}
        if (char === ',' && !stack.length) {parts.push(value.slice(start, index).trim()); start = index + 1;}
    }
    parts.push(value.slice(start).trim());
    return parts;
}

function findMatchingDelimiter(value: string, start: number, open: string, close: string): number {
    let depth = 0; let quote = '';
    for (let index = start; index < value.length; index++) {
        const char = value[index];
        if (quote) { if (char === quote && value[index - 1] !== '\\') {quote = '';} continue; }
        if (char === '"' || char === "'") {quote = char; continue;}
        if (char === open) {depth++;} else if (char === close && --depth === 0) {return index;}
    }
    return -1;
}

function skipSpaces(source: string, index: number): number { while (/\s/.test(source[index] ?? '')) {index++;} return index; }

export function isCudaProfileFile(filePath: string, languageId: string): boolean {
    return /\.(?:cu|cuh)$/i.test(path.basename(filePath)) || languageId === 'cuda-cpp';
}
