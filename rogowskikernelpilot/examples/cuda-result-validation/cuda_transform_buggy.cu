#include "protocol.hpp"
#include <cuda_runtime.h>

__global__ void transformKernel(const double* input, double* output, int count) {
    const int index = blockIdx.x * blockDim.x + threadIdx.x;
    if (index < count) {output[index] = input[index] * 3.0 + 2.25; /* Intentional arithmetic error. */}
}

int main(int argc, char** argv) {
    try {
        const auto input = kernelpilotReadInput(kernelpilotInputPath(argc, argv));
        double *deviceInput = nullptr, *deviceOutput = nullptr;
        const auto bytes = input.size() * sizeof(double);
        if (cudaMalloc(&deviceInput, bytes) != cudaSuccess || cudaMalloc(&deviceOutput, bytes) != cudaSuccess) {throw std::runtime_error("cudaMalloc failed");}
        auto status = cudaMemcpy(deviceInput, input.data(), bytes, cudaMemcpyHostToDevice);
        if (status == cudaSuccess) {transformKernel<<<static_cast<unsigned>((input.size() + 127) / 128), 128>>>(deviceInput, deviceOutput, static_cast<int>(input.size())); status = cudaGetLastError();}
        if (status == cudaSuccess) {status = cudaDeviceSynchronize();}
        std::vector<double> output(input.size());
        if (status == cudaSuccess) {status = cudaMemcpy(output.data(), deviceOutput, bytes, cudaMemcpyDeviceToHost);}
        cudaFree(deviceInput); cudaFree(deviceOutput);
        if (status != cudaSuccess) {throw std::runtime_error(cudaGetErrorString(status));}
        kernelpilotWriteOutput(output);
        return 0;
    } catch (const std::exception& error) {std::cerr << error.what() << '\n'; return 2;}
}
