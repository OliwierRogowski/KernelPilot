#include <cuda_runtime.h>

__global__ void initcheck_uninitialized_kernel(const int* input, int* output) {
    output[0] = input[0]; // input is allocated but never initialized by host or device.
}

int main() {
    int *input = nullptr, *output = nullptr;
    if (cudaMalloc(&input, sizeof(int)) != cudaSuccess || cudaMalloc(&output, sizeof(int)) != cudaSuccess) return 2;
    initcheck_uninitialized_kernel<<<1, 1>>>(input, output);
    (void)cudaDeviceSynchronize();
    int result = 0;
    (void)cudaMemcpy(&result, output, sizeof(int), cudaMemcpyDeviceToHost);
    (void)cudaFree(input); (void)cudaFree(output);
    return 0;
}
