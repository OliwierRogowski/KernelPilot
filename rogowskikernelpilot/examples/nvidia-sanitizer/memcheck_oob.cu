#include <cuda_runtime.h>

__global__ void memcheck_oob_kernel(int* output) {
    output[threadIdx.x] = 7; // thread 1 writes one int past the allocation.
}

int main() {
    int* output = nullptr;
    if (cudaMalloc(&output, sizeof(int)) != cudaSuccess) return 2;
    memcheck_oob_kernel<<<1, 2>>>(output);
    (void)cudaDeviceSynchronize();
    (void)cudaFree(output);
    return 0;
}
