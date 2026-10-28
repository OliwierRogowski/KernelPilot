/** Build a deterministic CUDA comparison program for the known CPU matmul signature. */
export function buildMatmulCudaBenchmarkTranslationUnit(source: string): string {
    const prelude = `
#include <cuda_runtime.h>
#include <algorithm>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>
`;
    return `${prelude}
#define main kernelpilot_original_main
#define matrixMultiplicationCPU kernelpilotUserMatrixMultiplicationCPU
${source}
#undef matrixMultiplicationCPU
#undef main
${matmulCudaHarness}
`;
}

const matmulCudaHarness = String.raw`
static void kernelpilotCudaCheck(cudaError_t status, const char* operation) {
    if (status != cudaSuccess) {
        throw std::runtime_error(std::string(operation) + ": " + cudaGetErrorString(status));
    }
}

extern "C" __global__ void kernelpilotMatrixMultiplicationKernel(
    const int* matrixA, const int* matrixB, int* matrixC, int n) {
    const int row = static_cast<int>(blockIdx.y * blockDim.y + threadIdx.y);
    const int column = static_cast<int>(blockIdx.x * blockDim.x + threadIdx.x);
    if (row < n && column < n) {
        int sum = 0;
        for (int k = 0; k < n; ++k) {
            sum += matrixA[static_cast<std::size_t>(row) * n + k] *
                   matrixB[static_cast<std::size_t>(k) * n + column];
        }
        matrixC[static_cast<std::size_t>(row) * n + column] = sum;
    }
}

struct KernelPilotCudaResources {
    int* hostA = nullptr;
    int* hostB = nullptr;
    int* hostC = nullptr;
    int* deviceA = nullptr;
    int* deviceB = nullptr;
    int* deviceC = nullptr;
    cudaStream_t stream = nullptr;
    cudaEvent_t h2dStart = nullptr;
    cudaEvent_t h2dStop = nullptr;
    cudaEvent_t kernelStart = nullptr;
    cudaEvent_t kernelStop = nullptr;
    cudaEvent_t d2hStart = nullptr;
    cudaEvent_t d2hStop = nullptr;

    ~KernelPilotCudaResources() {
        if (d2hStop) cudaEventDestroy(d2hStop);
        if (d2hStart) cudaEventDestroy(d2hStart);
        if (kernelStop) cudaEventDestroy(kernelStop);
        if (kernelStart) cudaEventDestroy(kernelStart);
        if (h2dStop) cudaEventDestroy(h2dStop);
        if (h2dStart) cudaEventDestroy(h2dStart);
        if (stream) cudaStreamDestroy(stream);
        if (deviceC) cudaFree(deviceC);
        if (deviceB) cudaFree(deviceB);
        if (deviceA) cudaFree(deviceA);
        if (hostC) cudaFreeHost(hostC);
        if (hostB) cudaFreeHost(hostB);
        if (hostA) cudaFreeHost(hostA);
    }

    KernelPilotCudaResources(const KernelPilotCudaResources&) = delete;
    KernelPilotCudaResources& operator=(const KernelPilotCudaResources&) = delete;
    KernelPilotCudaResources() = default;
};

struct KernelPilotMetric {
    const char* backend;
    const char* phase;
    int size;
    int sample;
    double milliseconds;
};

static long long kernelpilotChecksum(const std::vector<int>& values) {
    long long sum = 0;
    for (int value : values) sum += value;
    return sum;
}

static std::vector<int> kernelpilotCudaMatmulReference(int n,
                                                       const std::vector<int>& matrixA,
                                                       const std::vector<int>& matrixB) {
    const std::size_t elementCount = static_cast<std::size_t>(n) * n;
    if (n <= 0 || matrixA.size() != elementCount || matrixB.size() != elementCount) {
        throw std::runtime_error("Independent matrix reference received invalid inputs");
    }
    std::vector<int> reference(elementCount, 0);
    for (int row = 0; row < n; ++row) {
        for (int column = 0; column < n; ++column) {
            int sum = 0;
            for (int k = 0; k < n; ++k) {
                sum += matrixA[static_cast<std::size_t>(row) * n + k] *
                       matrixB[static_cast<std::size_t>(k) * n + column];
            }
            reference[static_cast<std::size_t>(row) * n + column] = sum;
        }
    }
    return reference;
}

static void kernelpilotRequireExact(const std::vector<int>& actual,
                                    const std::vector<int>& expected,
                                    const char* where, int n) {
    if (actual.size() != expected.size()) {
        throw std::runtime_error(std::string(where) + " returned an unexpected element count");
    }
    for (std::size_t index = 0; index < expected.size(); ++index) {
        if (actual[index] != expected[index]) {
            std::ostringstream message;
            message << where << " mismatch for n=" << n << " at element " << index
                    << ": actual=" << actual[index] << " expected=" << expected[index];
            throw std::runtime_error(message.str());
        }
    }
}

static void kernelpilotRunOneMatmulSize(int n, std::vector<KernelPilotMetric>& metrics,
                                        std::vector<std::pair<int, long long>>& checksums) {
    const std::size_t elementCount = static_cast<std::size_t>(n) * n;
    const std::size_t bytes = elementCount * sizeof(int);
    std::vector<int> matrixA(elementCount);
    std::vector<int> matrixB(elementCount);
    for (int row = 0; row < n; ++row) {
        for (int column = 0; column < n; ++column) {
            const std::size_t index = static_cast<std::size_t>(row) * n + column;
            matrixA[index] = (7 * row + 3 * column + 1) % 2;
            matrixB[index] = (5 * row + column + 1) % 3;
        }
    }

    using CpuMatmul = std::vector<int> (*)(int, int, int*, int, int, int*);
    CpuMatmul volatile cpuMatmul = &kernelpilotUserMatrixMultiplicationCPU;
    const std::vector<int> cpuReferenceCandidate = cpuMatmul(n, n, matrixA.data(), n, n, matrixB.data());
    const std::vector<int> expected = kernelpilotCudaMatmulReference(n, matrixA, matrixB);
    kernelpilotRequireExact(cpuReferenceCandidate, expected, "Original CPU result vs independent reference", n);
    const long long expectedChecksum = kernelpilotChecksum(expected);
    if (expectedChecksum == 0) {
        throw std::runtime_error("Deterministic matmul input must produce a nonzero checksum");
    }

    KernelPilotCudaResources resources;
    kernelpilotCudaCheck(cudaHostAlloc(reinterpret_cast<void**>(&resources.hostA), bytes, cudaHostAllocDefault), "cudaHostAlloc(A)");
    kernelpilotCudaCheck(cudaHostAlloc(reinterpret_cast<void**>(&resources.hostB), bytes, cudaHostAllocDefault), "cudaHostAlloc(B)");
    kernelpilotCudaCheck(cudaHostAlloc(reinterpret_cast<void**>(&resources.hostC), bytes, cudaHostAllocDefault), "cudaHostAlloc(C)");
    std::copy(matrixA.begin(), matrixA.end(), resources.hostA);
    std::copy(matrixB.begin(), matrixB.end(), resources.hostB);
    kernelpilotCudaCheck(cudaMalloc(reinterpret_cast<void**>(&resources.deviceA), bytes), "cudaMalloc(A)");
    kernelpilotCudaCheck(cudaMalloc(reinterpret_cast<void**>(&resources.deviceB), bytes), "cudaMalloc(B)");
    kernelpilotCudaCheck(cudaMalloc(reinterpret_cast<void**>(&resources.deviceC), bytes), "cudaMalloc(C)");
    kernelpilotCudaCheck(cudaStreamCreateWithFlags(&resources.stream, cudaStreamNonBlocking), "cudaStreamCreateWithFlags");
    kernelpilotCudaCheck(cudaEventCreate(&resources.h2dStart), "cudaEventCreate(h2dStart)");
    kernelpilotCudaCheck(cudaEventCreate(&resources.h2dStop), "cudaEventCreate(h2dStop)");
    kernelpilotCudaCheck(cudaEventCreate(&resources.kernelStart), "cudaEventCreate(kernelStart)");
    kernelpilotCudaCheck(cudaEventCreate(&resources.kernelStop), "cudaEventCreate(kernelStop)");
    kernelpilotCudaCheck(cudaEventCreate(&resources.d2hStart), "cudaEventCreate(d2hStart)");
    kernelpilotCudaCheck(cudaEventCreate(&resources.d2hStop), "cudaEventCreate(d2hStop)");

    const dim3 block(16, 16);
    const dim3 grid((n + block.x - 1) / block.x, (n + block.y - 1) / block.y);
    kernelpilotCudaCheck(cudaMemcpyAsync(resources.deviceA, resources.hostA, bytes, cudaMemcpyHostToDevice, resources.stream), "warmup H2D(A)");
    kernelpilotCudaCheck(cudaMemcpyAsync(resources.deviceB, resources.hostB, bytes, cudaMemcpyHostToDevice, resources.stream), "warmup H2D(B)");
    kernelpilotMatrixMultiplicationKernel<<<grid, block, 0, resources.stream>>>(resources.deviceA, resources.deviceB, resources.deviceC, n);
    kernelpilotCudaCheck(cudaGetLastError(), "warmup kernel launch");
    kernelpilotCudaCheck(cudaMemcpyAsync(resources.hostC, resources.deviceC, bytes, cudaMemcpyDeviceToHost, resources.stream), "warmup D2H(C)");
    kernelpilotCudaCheck(cudaStreamSynchronize(resources.stream), "warmup synchronize");
    const std::vector<int> warmup(resources.hostC, resources.hostC + elementCount);
    kernelpilotRequireExact(warmup, expected, "CUDA warmup", n);

    long long lastVerifiedGpuChecksum = 0;
    for (int sample = 0; sample < 5; ++sample) {
        const auto endToEndStart = std::chrono::steady_clock::now();
        kernelpilotCudaCheck(cudaEventRecord(resources.h2dStart, resources.stream), "record H2D start");
        kernelpilotCudaCheck(cudaMemcpyAsync(resources.deviceA, resources.hostA, bytes, cudaMemcpyHostToDevice, resources.stream), "timed H2D(A)");
        kernelpilotCudaCheck(cudaMemcpyAsync(resources.deviceB, resources.hostB, bytes, cudaMemcpyHostToDevice, resources.stream), "timed H2D(B)");
        kernelpilotCudaCheck(cudaEventRecord(resources.h2dStop, resources.stream), "record H2D stop");
        kernelpilotCudaCheck(cudaEventRecord(resources.kernelStart, resources.stream), "record kernel start");
        kernelpilotMatrixMultiplicationKernel<<<grid, block, 0, resources.stream>>>(resources.deviceA, resources.deviceB, resources.deviceC, n);
        kernelpilotCudaCheck(cudaGetLastError(), "timed kernel launch");
        kernelpilotCudaCheck(cudaEventRecord(resources.kernelStop, resources.stream), "record kernel stop");
        kernelpilotCudaCheck(cudaEventRecord(resources.d2hStart, resources.stream), "record D2H start");
        kernelpilotCudaCheck(cudaMemcpyAsync(resources.hostC, resources.deviceC, bytes, cudaMemcpyDeviceToHost, resources.stream), "timed D2H(C)");
        kernelpilotCudaCheck(cudaEventRecord(resources.d2hStop, resources.stream), "record D2H stop");
        kernelpilotCudaCheck(cudaEventSynchronize(resources.d2hStop), "synchronize timed sample");
        const auto endToEndStop = std::chrono::steady_clock::now();

        float h2dMs = 0.0F;
        float kernelMs = 0.0F;
        float d2hMs = 0.0F;
        kernelpilotCudaCheck(cudaEventElapsedTime(&h2dMs, resources.h2dStart, resources.h2dStop), "read H2D time");
        kernelpilotCudaCheck(cudaEventElapsedTime(&kernelMs, resources.kernelStart, resources.kernelStop), "read kernel time");
        kernelpilotCudaCheck(cudaEventElapsedTime(&d2hMs, resources.d2hStart, resources.d2hStop), "read D2H time");
        const double endToEndMs = std::chrono::duration<double, std::milli>(endToEndStop - endToEndStart).count();
        if (!(h2dMs > 0.0F) || !(kernelMs > 0.0F) || !(d2hMs > 0.0F) || !(endToEndMs > 0.0)) {
            throw std::runtime_error("CUDA timing returned a non-positive phase interval");
        }
        const std::vector<int> actual(resources.hostC, resources.hostC + elementCount);
        kernelpilotRequireExact(actual, expected, "CUDA result", n);
        const long long actualChecksum = kernelpilotChecksum(actual);
        if (actualChecksum != expectedChecksum) {
            throw std::runtime_error("CUDA checksum differs from the original CPU result");
        }
        lastVerifiedGpuChecksum = actualChecksum;

        const auto cpuStart = std::chrono::steady_clock::now();
        const std::vector<int> cpuResult = cpuMatmul(n, n, matrixA.data(), n, n, matrixB.data());
        const auto cpuStop = std::chrono::steady_clock::now();
        const double cpuMs = std::chrono::duration<double, std::milli>(cpuStop - cpuStart).count();
        kernelpilotRequireExact(cpuResult, expected, "Original CPU result", n);
        if (!(cpuMs > 0.0)) throw std::runtime_error("CPU matmul timing returned a non-positive interval");
        metrics.push_back({"CPU", "compute", n, sample, cpuMs});
        metrics.push_back({"CPU", "end_to_end", n, sample, cpuMs});
        metrics.push_back({"CUDA", "h2d", n, sample, static_cast<double>(h2dMs)});
        metrics.push_back({"CUDA", "kernel", n, sample, static_cast<double>(kernelMs)});
        metrics.push_back({"CUDA", "d2h", n, sample, static_cast<double>(d2hMs)});
        metrics.push_back({"CUDA", "end_to_end", n, sample, endToEndMs});
    }
    checksums.emplace_back(n, lastVerifiedGpuChecksum);
}

int main() {
    int deviceCount = 0;
    kernelpilotCudaCheck(cudaGetDeviceCount(&deviceCount), "cudaGetDeviceCount");
    if (deviceCount < 1) throw std::runtime_error("No CUDA device is available");
    kernelpilotCudaCheck(cudaSetDevice(0), "cudaSetDevice");
    std::vector<KernelPilotMetric> metrics;
    std::vector<std::pair<int, long long>> checksums;
    for (int n : {70, 128, 256}) kernelpilotRunOneMatmulSize(n, metrics, checksums);

    std::cout << "KP_DEVICE,OK," << deviceCount << "\n";
    for (const auto& result : checksums) {
        std::cout << "KP_VERIFY_RESULT," << result.first << ",PASS," << result.second << "\n";
    }
    std::cout << std::fixed << std::setprecision(9);
    for (const auto& metric : metrics) {
        std::cout << "KP_METRIC," << metric.backend << "," << metric.phase << ","
                  << metric.size << "," << metric.sample << "," << metric.milliseconds << "\n";
    }
    std::cout << "KP_VERIFY,OK\n";
    return 0;
}
`;
