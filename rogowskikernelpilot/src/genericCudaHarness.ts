import { detectFixedWorkloadElementCount } from './benchmarkWorkload';

/** Adapter-only CUDA contract and deterministic runner for algorithm-specific kernels. */
export function validateGenericCudaAdapter(adapter: string, targetFunction?: string, mainOnlySource?: string, originalSource?: string): string[] {
    const classMatch = /class\s+KernelPilotGeneratedAdapter\b/.exec(adapter);
    const classStart = classMatch?.index ?? -1;
    const classBody = classStart >= 0 ? blockBody(adapter, adapter.indexOf('{', classStart)) : undefined;
    const referenceBody = methodBody(classBody ?? '', 'reference');
    const copyHookBody = methodBody(classBody ?? '', 'h2dCopies');
    const kernelHookBody = methodBody(classBody ?? '', 'kernels');
    const downloadHookBody = methodBody(classBody ?? '', 'd2hCopies');
    const namespaceKernel = classStart >= 0 && /^\s*__global__\s+void\s+[A-Za-z_]\w*\s*\(/m.test(adapter.slice(0, classStart));
    const hasMisplacedKernel = /\b__global__\b/.test(adapter.slice(Math.max(classStart, 0)));
    const missing = [
        !classBody ? 'complete KernelPilotGeneratedAdapter class' : '',
        !/\bvoid\s+setup\s*\(\s*std::size_t\s+\w+\s*\)/.test(classBody ?? '') ? 'setup(size)' : '',
        !/\bstd::\s*vector\s*<\s*KernelPilotCopy\s*>\s+h2dCopies\s*\(\s*\)/.test(classBody ?? '') || !copyHookBody ? 'h2dCopies() method with exact signature and body' : '',
        !/\bstd::\s*vector\s*<\s*KernelPilotKernelLaunch\s*>\s+kernels\s*\(\s*\)/.test(classBody ?? '') || !kernelHookBody ? 'kernels() method with exact signature and body' : '',
        !/\bstd::\s*vector\s*<\s*KernelPilotCopy\s*>\s+d2hCopies\s*\(\s*\)/.test(classBody ?? '') || !downloadHookBody ? 'd2hCopies() method with exact signature and body' : '',
        !/\bstd::\s*vector\s*<\s*double\s*>\s+reference\s*\(\s*\)/.test(classBody ?? '') ? 'reference() method with exact signature' : '',
        !referenceBody ? 'reference() CPU oracle' : '',
        targetFunction && referenceBody && !new RegExp(`\\b${escapeRegex(targetFunction)}\\s*\\(`).test(referenceBody)
            ? `direct call to original CPU target ${targetFunction} in reference()` : '',
        !/\bvoid\s+cleanup\s*\(\s*\)/.test(classBody ?? '') ? 'cleanup() method' : '',
        !namespaceKernel ? 'namespace-level __global__ void kernel before adapter class' : '',
        hasMisplacedKernel ? 'namespace-level kernel declaration (not a class member)' : '',
        /\b(?:std::)?vector\s*<[^;]+>\s+(?:h2dCopies|kernels|d2hCopies)\s*;/.test(classBody ?? '')
            ? 'non-colliding hook member names (use h2dDescriptors_, launchDescriptors_, d2hDescriptors_)' : '',
        /\b(?:setup|h2dCopies|kernels|d2hCopies|reference|cleanup)\s*(?:;|=|\[)/.test(classBody ?? '')
            ? 'no fields may collide with lifecycle method names' : '',
        !/KernelPilotKernelLaunch/.test(adapter) ? 'kernel launch descriptors' : '',
        !/KernelPilotCopy/.test(adapter) ? 'copy descriptors' : '',
        !/\bstd::\s*size_t\s+n_\s*(?:\{\s*\})?\s*;/.test(classBody ?? '') || !/\bn_\s*=\s*n\s*;/.test(classBody ?? '')
            ? 'persistent n_ workload size initialized in setup' : '',
        !/\bstd::\s*vector\s*<\s*void\s*\*>\s+kernelArgs_\s*;/.test(classBody ?? '') ? 'std::vector<void*> kernelArgs_ field' : '',
        !/\bkernelpilotH2D\s*\(/.test(adapter) || !/\bkernelpilotD2H(?:Result)?\s*<\s*/.test(adapter)
            ? 'runner copy descriptor helpers (kernelpilotH2D, kernelpilotD2HResult<T>)' : '',
        !/\bkernelpilotKernel\s*\(/.test(adapter) ? 'runner launch descriptor helper (kernelpilotKernel)' : '',
        !/\bKernelPilotBufferRegistry\s+buffers_\s*;/.test(classBody ?? '') || !/\bbuffers_\s*\.\s*pinned\s*</.test(classBody ?? '')
            ? 'checked runner pinned-buffer registry usage' : '',
        !/\bbuffers_\s*\.\s*device\s*</.test(classBody ?? '') ? 'checked runner device-buffer registry usage' : '',
        !/\bkernelpilotCheck\s*\(\s*buffers_\s*\.\s*release\s*\(/.test(classBody ?? '')
            ? 'checked runner buffer cleanup' : '',
        referenceBody && !/\bn_\b/.test(referenceBody)
            ? 'reference() must use persistent n_ for the workload size, not an out-of-scope setup parameter' : '',
        /\bint\s+main\s*\(/.test(adapter) ? 'adapter must not define main()' : '',
        /<<<|KP_METRIC|KP_VERIFY_RESULT|KP_DEVICE,OK/.test(adapter) ? 'adapter must not own launches or reporting' : '',
        /^\s*#\s*include\b/m.test(adapter) ? 'adapter must not include or redefine the original translation unit' : '',
        targetFunction && new RegExp(`\\b${escapeRegex(targetFunction)}\\s*\\([^;{}]*\\)\\s*\\{`).test(adapter)
            ? `adapter must call but not redefine original CPU function ${targetFunction}` : ''
    ].filter(Boolean);
    if (mainOnlySource !== undefined) {
        if (!/\b(?:std\s*::\s*)?transform_reduce\s*\(/.test(mainOnlySource)) {
            missing.push('supported main-only transform_reduce operation in original source');
        } else if (!/\b(?:std\s*::\s*)?transform_reduce\s*\(/.test(referenceBody ?? '')) {
            missing.push('reference() must compute an independent CPU transform_reduce oracle');
        }
        const sourceLambdas = normalizedCudaLambdas(mainOnlySource);
        const adapterLambdas = normalizedCudaLambdas(adapter);
        if (sourceLambdas.length && sourceLambdas.some(lambda => !adapterLambdas.includes(lambda))) {
            missing.push('reference() must preserve the source transform_reduce lambda operation');
        }
        const policy = mainOnlySource.match(/\b(?:std\s*::\s*)?execution\s*::\s*(seq|par|par_unseq|unseq)\b/)?.[1];
        if (policy && !new RegExp(`\\b(?:std\\s*::\\s*)?execution\\s*::\\s*${policy}\\b`).test(referenceBody ?? '')) {
            missing.push(`reference() must preserve the source std::execution::${policy} policy`);
        }
    }
    if (targetFunction && originalSource && detectFixedWorkloadElementCount(originalSource)) {
        const sourceSignature = new RegExp(`\\b${escapeRegex(targetFunction)}\\s*\\(([^)]*)\\)`).exec(originalSource)?.[1] ?? '';
        const vectorParameter = sourceSignature.match(/(?:const\s+)?(?:std\s*::\s*)?vector\s*<[^>]+>\s*&?\s*([A-Za-z_]\w*)/);
        if (vectorParameter) {
            const sourceInitializer = new RegExp(`\\b${escapeRegex(vectorParameter[1])}\\s*\\[\\s*([A-Za-z_]\\w*)\\s*\\]\\s*=\\s*([^;]+);`).exec(originalSource);
            const countArgument = String.raw`(?:n_|n_\s*==\s*0\s*\?\s*1\s*:\s*n_)`;
            if (!new RegExp(String.raw`buffers_\s*\.\s*pinned\s*<[^>]+>\s*\(\s*${countArgument}\s*\)`).test(adapter) ||
                !new RegExp(String.raw`buffers_\s*\.\s*device\s*<[^>]+>\s*\(\s*${countArgument}\s*\)`).test(adapter)) {
                missing.push('pinned host and device input buffers allocated for all n_ source elements');
            }
            if (sourceInitializer) {
                const expression = sourceInitializer[2].replace(/\s+/g, '');
                if (!adapter.replace(/\s+/g, '').includes(expression)) {
                    missing.push('setup() must preserve the source input initialization expression');
                }
                if (!new RegExp(`<\\s*n_\\b`).test(adapter)) {
                    missing.push('setup() must initialize every source input element up to n_');
                }
            }
        }
    }
    return missing;
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function methodBody(source: string, method: string): string | undefined {
    const match = new RegExp(`\\b${method}\\s*\\([^)]*\\)\\s*\\{`).exec(source);
    if (!match) { return undefined; }
    const start = match.index + match[0].length;
    let depth = 1;
    for (let index = start; index < source.length; index++) {
        if (source[index] === '{') { depth++; }
        else if (source[index] === '}' && --depth === 0) { return source.slice(start, index); }
    }
    return undefined;
}

function blockBody(source: string, openBrace: number): string | undefined {
    if (openBrace < 0 || source[openBrace] !== '{') { return undefined; }
    let depth = 1;
    for (let index = openBrace + 1; index < source.length; index++) {
        if (source[index] === '{') { depth++; }
        else if (source[index] === '}' && --depth === 0) { return source.slice(openBrace + 1, index); }
    }
    return undefined;
}

export function buildGenericCudaBenchmarkTranslationUnit(
    source: string,
    adapter: string,
    mainOnly = false,
    workloadSizes: [number, number, number] = [64, 128, 256]
): string {
    const invalid = validateGenericCudaAdapter(adapter, undefined, mainOnly ? source : undefined, source);
    if (invalid.length) { throw new Error(`Invalid generated CUDA adapter: missing or forbidden ${invalid.join(', ')}`); }
    const runner = withCudaRunnerWorkloadSizes(genericRunner, workloadSizes);
    return `${genericPrelude}\n#define main kernelpilot_original_main\n${source}\n#undef main\n${adapter}\n${runner}`;
}

export function withCudaRunnerWorkloadSizes(runner: string, sizes: [number, number, number]): string {
    return runner.replace('std::vector<int> sizes{64,128,256};', `std::vector<int> sizes{${sizes.join(',')}};`);
}

function normalizedCudaLambdas(code: string): string[] {
    const result: string[] = [];
    const pattern = /\[[^\]\n]*\]\s*(?:\([^)]*\))?\s*\{/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(code)) !== null) {
        const open = code.indexOf('{', match.index + match[0].length - 1);
        let depth = 1;
        let end = open + 1;
        for (; end < code.length && depth > 0; end++) {
            if (code[end] === '{') { depth++; }
            else if (code[end] === '}') { depth--; }
        }
        if (depth === 0) {
            result.push(code.slice(open + 1, end - 1).replace(/\s+/g, ''));
            pattern.lastIndex = end;
        }
    }
    return result;
}

const genericPrelude = String.raw`
#include <cuda_runtime.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <iomanip>
#include <iostream>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <vector>
static void kernelpilotCheck(cudaError_t code, const char* operation) {
    if (code != cudaSuccess) throw std::runtime_error(std::string(operation) + ": " + cudaGetErrorString(code));
}
enum class KernelPilotNumericType { Int32, Int64, Float32, Float64 };
struct KernelPilotCopy {
    void* destination; const void* source; std::size_t bytes; cudaMemcpyKind kind;
    bool isResult = false; KernelPilotNumericType resultType = KernelPilotNumericType::Int32; std::size_t elements = 0;
};
struct KernelPilotKernelLaunch { const void* function; dim3 grid; dim3 block; void** arguments; std::size_t sharedBytes; };
inline KernelPilotCopy kernelpilotH2D(void* device, const void* pinnedHost, std::size_t bytes) {
    return {device,pinnedHost,bytes,cudaMemcpyHostToDevice,false,KernelPilotNumericType::Int32,0};
}
template<class T> inline KernelPilotCopy kernelpilotD2HResult(T* pinnedHost, const T* device, std::size_t elements) {
    static_assert(std::is_same_v<T,std::int32_t> || std::is_same_v<T,std::int64_t> || std::is_same_v<T,long long> ||
                  std::is_same_v<T,float> || std::is_same_v<T,double>, "unsupported numeric result type");
    constexpr KernelPilotNumericType type = std::is_same_v<T,std::int32_t> ? KernelPilotNumericType::Int32 :
        (std::is_same_v<T,std::int64_t> || std::is_same_v<T,long long>) ? KernelPilotNumericType::Int64 :
        std::is_same_v<T,float> ? KernelPilotNumericType::Float32 : KernelPilotNumericType::Float64;
    return {pinnedHost,device,sizeof(T)*elements,cudaMemcpyDeviceToHost,true,type,elements};
}
template<class T> inline KernelPilotCopy kernelpilotD2H(T* pinnedHost, const T* device, std::size_t elements) {
    return {pinnedHost,device,sizeof(T)*elements,cudaMemcpyDeviceToHost,false,KernelPilotNumericType::Int32,0};
}
inline KernelPilotKernelLaunch kernelpilotKernel(const void* function, dim3 grid, dim3 block, void** arguments, std::size_t sharedBytes=0) {
    return {function,grid,block,arguments,sharedBytes};
}
class KernelPilotBufferRegistry {
    std::vector<void*> pinned_, device_;
public:
    template<class T> T* pinned(std::size_t count) {
        T* pointer=nullptr; kernelpilotCheck(cudaHostAlloc(reinterpret_cast<void**>(&pointer),sizeof(T)*count,cudaHostAllocDefault),"cudaHostAlloc");
        try { pinned_.push_back(pointer); } catch (...) { cudaFreeHost(pointer); throw; } return pointer;
    }
    template<class T> T* device(std::size_t count) {
        T* pointer=nullptr; kernelpilotCheck(cudaMalloc(reinterpret_cast<void**>(&pointer),sizeof(T)*count),"cudaMalloc");
        try { device_.push_back(pointer); } catch (...) { cudaFree(pointer); throw; } return pointer;
    }
    cudaError_t release() noexcept {
        cudaError_t first=cudaSuccess;
        for (void* pointer : device_) { const auto status=cudaFree(pointer); if (first==cudaSuccess && status!=cudaSuccess) first=status; }
        for (void* pointer : pinned_) { const auto status=cudaFreeHost(pointer); if (first==cudaSuccess && status!=cudaSuccess) first=status; }
        device_.clear(); pinned_.clear(); return first;
    }
    ~KernelPilotBufferRegistry() { (void)release(); }
};
`;

const genericRunner = String.raw`
static void kernelpilotRequirePinnedHost(const void* pointer) {
    cudaPointerAttributes attributes{};
    kernelpilotCheck(cudaPointerGetAttributes(&attributes, pointer), "cudaPointerGetAttributes");
    if (attributes.type != cudaMemoryTypeHost) throw std::runtime_error("transfer descriptor must use pinned host memory");
}
static double kernelpilotChecksum(const std::vector<double>& values) {
    double sum = 0.0; for (double value : values) sum += value; return sum;
}
static std::vector<double> kernelpilotCollectResult(const std::vector<KernelPilotCopy>& copies) {
    std::vector<double> values;
    for (const auto& copy : copies) {
        if (!copy.isResult) continue;
        const std::size_t width = copy.resultType == KernelPilotNumericType::Int32 ? sizeof(std::int32_t) :
            copy.resultType == KernelPilotNumericType::Int64 ? sizeof(std::int64_t) :
            copy.resultType == KernelPilotNumericType::Float32 ? sizeof(float) : sizeof(double);
        if (!copy.elements || copy.bytes != width * copy.elements) throw std::runtime_error("invalid result metadata on D2H descriptor");
        for (std::size_t i=0; i<copy.elements; ++i) {
            switch (copy.resultType) {
                case KernelPilotNumericType::Int32: values.push_back(static_cast<double>(static_cast<const std::int32_t*>(copy.destination)[i])); break;
                case KernelPilotNumericType::Int64: values.push_back(static_cast<double>(static_cast<const std::int64_t*>(copy.destination)[i])); break;
                case KernelPilotNumericType::Float32: values.push_back(static_cast<double>(static_cast<const float*>(copy.destination)[i])); break;
                case KernelPilotNumericType::Float64: values.push_back(static_cast<const double*>(copy.destination)[i]); break;
            }
        }
    }
    if (values.empty()) throw std::runtime_error("adapter did not mark any D2H output as mathematical result");
    return values;
}
static void kernelpilotVerify(const std::vector<double>& actual, const std::vector<double>& expected, std::size_t n) {
    if (actual.empty() || actual.size() != expected.size()) throw std::runtime_error("adapter output shape mismatch");
    for (std::size_t i = 0; i < actual.size(); ++i) {
        const double tolerance = 1e-10 + 1e-8 * std::abs(expected[i]);
        if (!std::isfinite(actual[i]) || std::abs(actual[i] - expected[i]) > tolerance)
            throw std::runtime_error("CUDA result differs from CPU oracle at size=" + std::to_string(n) + " index=" + std::to_string(i));
    }
}
struct KernelPilotRunnerResources {
    cudaStream_t stream = nullptr;
    cudaEvent_t h0 = nullptr, h1 = nullptr, k0 = nullptr, k1 = nullptr, d0 = nullptr, d1 = nullptr;
    ~KernelPilotRunnerResources() {
        if (d1) cudaEventDestroy(d1); if (d0) cudaEventDestroy(d0); if (k1) cudaEventDestroy(k1);
        if (k0) cudaEventDestroy(k0); if (h1) cudaEventDestroy(h1); if (h0) cudaEventDestroy(h0);
        if (stream) cudaStreamDestroy(stream);
    }
};
static float kernelpilotElapsed(cudaEvent_t a, cudaEvent_t b) {
    float ms = 0; kernelpilotCheck(cudaEventElapsedTime(&ms, a, b), "cudaEventElapsedTime");
    if (!(ms > 0) || !std::isfinite(ms)) throw std::runtime_error("CUDA event interval is below timer resolution; refusing to report a fabricated sample");
    return ms;
}
int main() {
 try {
    int count = 0; kernelpilotCheck(cudaGetDeviceCount(&count), "cudaGetDeviceCount");
    if (count < 1) throw std::runtime_error("No CUDA device available");
    kernelpilotCheck(cudaSetDevice(0), "cudaSetDevice");
    std::cout << "KP_DEVICE,OK," << count << "\n";
    std::vector<int> sizes{64,128,256};
    for (int n : sizes) {
      KernelPilotGeneratedAdapter adapter;
      struct CleanupGuard {
          KernelPilotGeneratedAdapter& a; bool active = true;
          void run() { if (active) { a.cleanup(); active = false; } }
          ~CleanupGuard() { if (active) { try { a.cleanup(); } catch (...) {} } }
      } cleanup{adapter};
      const auto setupBegin = std::chrono::steady_clock::now();
      adapter.setup(static_cast<std::size_t>(n));
      const double setupMs = std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-setupBegin).count();
      // One setup observation only: it combines adapter data preparation and host/pinned/device allocation.
      std::cout << std::fixed << std::setprecision(9) << "KP_PROFILE_SETUP," << n << "," << setupMs << "\n";
      auto references = adapter.reference();
      auto h2d = adapter.h2dCopies(); auto launches = adapter.kernels(); auto d2h = adapter.d2hCopies();
      if (h2d.empty() || d2h.empty() || launches.empty()) throw std::runtime_error("adapter must provide H2D, kernel, and D2H descriptors");
      for (const auto& c : h2d) { if (!c.bytes || c.kind != cudaMemcpyHostToDevice) throw std::runtime_error("invalid H2D descriptor"); kernelpilotRequirePinnedHost(c.source); }
      for (const auto& c : d2h) { if (!c.bytes || c.kind != cudaMemcpyDeviceToHost) throw std::runtime_error("invalid D2H descriptor"); kernelpilotRequirePinnedHost(c.destination); }
      KernelPilotRunnerResources r;
      kernelpilotCheck(cudaStreamCreateWithFlags(&r.stream, cudaStreamNonBlocking), "cudaStreamCreate");
      kernelpilotCheck(cudaEventCreate(&r.h0), "cudaEventCreate"); kernelpilotCheck(cudaEventCreate(&r.h1), "cudaEventCreate");
      kernelpilotCheck(cudaEventCreate(&r.k0), "cudaEventCreate"); kernelpilotCheck(cudaEventCreate(&r.k1), "cudaEventCreate");
      kernelpilotCheck(cudaEventCreate(&r.d0), "cudaEventCreate"); kernelpilotCheck(cudaEventCreate(&r.d1), "cudaEventCreate");
      auto doH2D = [&] { for (const auto& c : h2d) kernelpilotCheck(cudaMemcpyAsync(c.destination,c.source,c.bytes,c.kind,r.stream), "H2D copy"); };
      auto doD2H = [&] { for (const auto& c : d2h) kernelpilotCheck(cudaMemcpyAsync(c.destination,c.source,c.bytes,c.kind,r.stream), "D2H copy"); };
      doH2D(); for (const auto& launch : launches) kernelpilotCheck(cudaLaunchKernel(launch.function,launch.grid,launch.block,launch.arguments,launch.sharedBytes,r.stream), "cudaLaunchKernel warmup");
      kernelpilotCheck(cudaGetLastError(), "warmup launch status"); doD2H(); kernelpilotCheck(cudaStreamSynchronize(r.stream), "warmup synchronize");
      std::vector<double> verified;
      constexpr int sampleCount = 11;
      for (int sample = 0; sample < sampleCount; ++sample) {
        double cpuMs = 0.0, cpuEndToEndMs = 0.0, endToEnd = 0.0;
        float h2dMs = 0.0F, kernelMs = 0.0F, d2hMs = 0.0F;
        auto measureCpu = [&] {
          const auto cpuEndToEndBegin = std::chrono::steady_clock::now();
          const auto cpuBegin = std::chrono::steady_clock::now();
          auto cpuResult = adapter.reference();
          const auto cpuEnd = std::chrono::steady_clock::now();
          kernelpilotVerify(cpuResult,references,n);
          const double cpuChecksum = kernelpilotChecksum(cpuResult);
          if (!std::isfinite(cpuChecksum)) throw std::runtime_error("CPU oracle checksum is not finite");
          const auto cpuEndToEndEnd = std::chrono::steady_clock::now();
          cpuMs = std::chrono::duration<double,std::milli>(cpuEnd-cpuBegin).count();
          cpuEndToEndMs = std::chrono::duration<double,std::milli>(cpuEndToEndEnd-cpuEndToEndBegin).count();
        };
        auto measureCuda = [&] {
          const auto begin = std::chrono::steady_clock::now();
          kernelpilotCheck(cudaEventRecord(r.h0,r.stream), "record H2D start"); doH2D(); kernelpilotCheck(cudaEventRecord(r.h1,r.stream), "record H2D stop");
          kernelpilotCheck(cudaEventRecord(r.k0,r.stream), "record kernel start");
          std::size_t issued = 0; for (const auto& launch : launches) { kernelpilotCheck(cudaLaunchKernel(launch.function,launch.grid,launch.block,launch.arguments,launch.sharedBytes,r.stream), "cudaLaunchKernel"); ++issued; }
          if (!issued) throw std::runtime_error("runner issued no CUDA kernel launches");
          kernelpilotCheck(cudaGetLastError(), "kernel launch status"); kernelpilotCheck(cudaEventRecord(r.k1,r.stream), "record kernel stop");
          kernelpilotCheck(cudaEventRecord(r.d0,r.stream), "record D2H start"); doD2H(); kernelpilotCheck(cudaEventRecord(r.d1,r.stream), "record D2H stop");
          kernelpilotCheck(cudaEventSynchronize(r.d1), "sample synchronize");
          auto actual = kernelpilotCollectResult(d2h); kernelpilotVerify(actual,references,n);
          const double cudaChecksum = kernelpilotChecksum(actual);
          if (!std::isfinite(cudaChecksum)) throw std::runtime_error("CUDA result checksum is not finite");
          verified = std::move(actual);
          const auto end = std::chrono::steady_clock::now();
          endToEnd = std::chrono::duration<double,std::milli>(end-begin).count();
          h2dMs = kernelpilotElapsed(r.h0,r.h1); kernelMs = kernelpilotElapsed(r.k0,r.k1); d2hMs = kernelpilotElapsed(r.d0,r.d1);
        };
        // Alternate order to reduce systematic CPU-first/GPU-first clock and thermal bias.
        if (sample % 2 == 0) { measureCpu(); measureCuda(); }
        else { measureCuda(); measureCpu(); }
        std::cout << std::fixed << std::setprecision(9)
          << "KP_METRIC,CPU,compute,"<<n<<","<<sample<<","<<cpuMs<<"\n"
          << "KP_METRIC,CPU,end_to_end,"<<n<<","<<sample<<","<<cpuEndToEndMs<<"\n"
          << "KP_METRIC,CUDA,h2d,"<<n<<","<<sample<<","<<h2dMs<<"\n"
          << "KP_METRIC,CUDA,kernel,"<<n<<","<<sample<<","<<kernelMs<<"\n"
          << "KP_METRIC,CUDA,d2h,"<<n<<","<<sample<<","<<d2hMs<<"\n"
          << "KP_METRIC,CUDA,end_to_end,"<<n<<","<<sample<<","<<endToEnd<<"\n";
      }
      cleanup.run();
      std::cout << "KP_VERIFY_RESULT,"<<n<<",PASS,"<<kernelpilotChecksum(verified)<<"\n";
    }
    std::cout << "KP_VERIFY,OK\n"; return 0;
 } catch (const std::exception& e) { std::cerr << "CUDA benchmark failed: "<<e.what()<<"\n"; return 2; }
}
`;
