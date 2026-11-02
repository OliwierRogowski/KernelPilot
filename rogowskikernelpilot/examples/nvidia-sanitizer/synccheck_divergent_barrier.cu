#include <cuda_runtime.h>

__global__ void synccheck_divergent_barrier_kernel() {
    const unsigned int lane = threadIdx.x;
    const unsigned int mask = __ballot_sync(0xffffffffu, lane < 16);
    if (lane <= 16) {
        __syncwarp(mask); // Lane 16 executes the barrier but is absent from its participation mask.
    }
}

int main() {
    synccheck_divergent_barrier_kernel<<<1, 32>>>();
    (void)cudaDeviceSynchronize();
    return 0;
}
