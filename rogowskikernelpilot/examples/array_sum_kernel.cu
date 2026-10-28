#include <cuda_runtime.h>

__global__ void arraySumKernel(const int* values, long long* total, int count)
{
    __shared__ long long partialSums[256];
    const int thread = static_cast<int>(threadIdx.x);
    if (blockIdx.x != 0 || gridDim.x != 1 || blockDim.x != 256)
    {
        return;
    }

    long long threadSum = 0;
    for (int index = thread; index < count; index += 256)
    {
        threadSum += values[index];
    }
    partialSums[thread] = threadSum;
    __syncthreads();

    for (int offset = 128; offset > 0; offset >>= 1)
    {
        if (thread < offset)
        {
            partialSums[thread] += partialSums[thread + offset];
        }
        __syncthreads();
    }

    if (thread == 0)
    {
        *total = partialSums[0];
    }
}
