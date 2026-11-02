#include <cuda_runtime.h>

__global__ void racecheck_shared_hazard_kernel(int* output) {
    __shared__ int values[32];
    const int lane = static_cast<int>(threadIdx.x);
    if (lane < 32) {values[lane] = lane + 11;}
    if (lane >= 32 && lane < 64) {output[lane - 32] = values[lane - 32];} // Missing ordering between warps.
}

int main() {
    int* output = nullptr;
    if (cudaMalloc(&output, 32 * sizeof(int)) != cudaSuccess) return 2;
    racecheck_shared_hazard_kernel<<<1, 64>>>(output);
    (void)cudaDeviceSynchronize();
    (void)cudaFree(output);
    return 0;
}
