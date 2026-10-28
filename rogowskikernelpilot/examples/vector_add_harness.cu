#include <cuda_runtime.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <numeric>
#include <vector>

#ifndef KERNELPILOT_KERNEL_SOURCE
#error "Compile through KernelPilot with KERNELPILOT_KERNEL_SOURCE defined."
#endif
#include KERNELPILOT_KERNEL_SOURCE

static void checkCuda(cudaError_t error, const char* operation) {
    if (error != cudaSuccess) {
        std::fprintf(stderr, "%s failed: %s\n", operation, cudaGetErrorString(error));
        std::exit(2);
    }
}

static bool runCase(int n, const char* label) {
    std::vector<float> a(static_cast<size_t>(n));
    std::vector<float> b(static_cast<size_t>(n));
    std::vector<float> output(static_cast<size_t>(n));
    std::vector<float> reference(static_cast<size_t>(n));
    for (int i = 0; i < n; ++i) {
        a[static_cast<size_t>(i)] = static_cast<float>((i * 17) % 101 - 50) * 0.125f;
        b[static_cast<size_t>(i)] = static_cast<float>((i * 29) % 89 - 44) * 0.0625f;
        reference[static_cast<size_t>(i)] = a[static_cast<size_t>(i)] + b[static_cast<size_t>(i)];
    }

    float *deviceA = nullptr, *deviceB = nullptr, *deviceC = nullptr;
    checkCuda(cudaMalloc(&deviceA, static_cast<size_t>(n) * sizeof(float)), "cudaMalloc(a)");
    checkCuda(cudaMalloc(&deviceB, static_cast<size_t>(n) * sizeof(float)), "cudaMalloc(b)");
    checkCuda(cudaMalloc(&deviceC, static_cast<size_t>(n) * sizeof(float)), "cudaMalloc(c)");
    checkCuda(cudaMemcpy(deviceA, a.data(), static_cast<size_t>(n) * sizeof(float), cudaMemcpyHostToDevice), "copy a");
    checkCuda(cudaMemcpy(deviceB, b.data(), static_cast<size_t>(n) * sizeof(float), cudaMemcpyHostToDevice), "copy b");

    constexpr int blockSize = 256;
    const int blocks = (n + blockSize - 1) / blockSize;
    for (int warmup = 0; warmup < 10; ++warmup) {
        vectorAdd<<<blocks, blockSize>>>(deviceA, deviceB, deviceC, n);
    }
    checkCuda(cudaGetLastError(), "warmup launch");
    checkCuda(cudaDeviceSynchronize(), "warmup synchronization");
    checkCuda(cudaMemcpy(output.data(), deviceC, static_cast<size_t>(n) * sizeof(float), cudaMemcpyDeviceToHost), "copy result");
    bool passed = true;
    for (int i = 0; i < n; ++i) {
        if (!std::isfinite(output[static_cast<size_t>(i)]) ||
            std::fabs(output[static_cast<size_t>(i)] - reference[static_cast<size_t>(i)]) > 1.0e-6f) {
            passed = false;
            break;
        }
    }

    cudaEvent_t start{}, stop{};
    checkCuda(cudaEventCreate(&start), "cudaEventCreate(start)");
    checkCuda(cudaEventCreate(&stop), "cudaEventCreate(stop)");
    constexpr int repeats = 500;
    std::vector<double> samples;
    for (int sample = 0; sample < 11; ++sample) {
        checkCuda(cudaEventRecord(start), "cudaEventRecord(start)");
        for (int repeat = 0; repeat < repeats; ++repeat) {
            vectorAdd<<<blocks, blockSize>>>(deviceA, deviceB, deviceC, n);
        }
        checkCuda(cudaGetLastError(), "timed launch");
        checkCuda(cudaEventRecord(stop), "cudaEventRecord(stop)");
        checkCuda(cudaEventSynchronize(stop), "timed synchronization");
        float elapsedMs = 0.0f;
        checkCuda(cudaEventElapsedTime(&elapsedMs, start, stop), "cudaEventElapsedTime");
        samples.push_back(static_cast<double>(elapsedMs) / repeats);
    }
    std::sort(samples.begin(), samples.end());
    const double median = samples[samples.size() / 2];
    const double p95 = samples[static_cast<size_t>(std::ceil(0.95 * static_cast<double>(samples.size() - 1)))];
    std::printf("KP_RESULT,%s,%s,%.9f,%.9f\n", label, passed ? "PASS" : "FAIL", median, p95);

    checkCuda(cudaEventDestroy(start), "cudaEventDestroy(start)");
    checkCuda(cudaEventDestroy(stop), "cudaEventDestroy(stop)");
    checkCuda(cudaFree(deviceA), "cudaFree(a)");
    checkCuda(cudaFree(deviceB), "cudaFree(b)");
    checkCuda(cudaFree(deviceC), "cudaFree(c)");
    return passed;
}

int main() {
    runCase(1, "edge_one");
    runCase(257, "odd_tail");
    runCase(65536, "large_vector");
    // The structured KP_RESULT records carry correctness status for both runs.
    // Exit non-zero only for harness/runtime setup errors, not an expected FAIL record.
    return 0;
}
