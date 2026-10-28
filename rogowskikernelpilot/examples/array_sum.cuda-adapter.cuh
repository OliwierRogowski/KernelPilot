__global__ void kpArraySumKernel(const int* values, long long* total, int count) {
    __shared__ long long partial[256];
    const int thread = static_cast<int>(threadIdx.x);
    long long local = 0;
    for (int index = thread; index < count; index += static_cast<int>(blockDim.x)) {
        local += values[index];
    }
    partial[thread] = local;
    __syncthreads();
    for (int offset = 128; offset > 0; offset >>= 1) {
        if (thread < offset) { partial[thread] += partial[thread + offset]; }
        __syncthreads();
    }
    if (thread == 0) { *total = partial[0]; }
}

class KernelPilotGeneratedAdapter {
    KernelPilotBufferRegistry buffers_;
    std::size_t n_{};
    int countArg_{};
    int* hValues_{};
    long long* hTotal_{};
    int* dValues_{};
    long long* dTotal_{};
    std::vector<void*> kernelArgs_;
    std::vector<KernelPilotCopy> h2dDescriptors_;
    std::vector<KernelPilotKernelLaunch> launchDescriptors_;
    std::vector<KernelPilotCopy> d2hDescriptors_;

public:
    void setup(std::size_t n) {
        n_ = n;
        countArg_ = static_cast<int>(n_);
        hValues_ = buffers_.pinned<int>(n_);
        hTotal_ = buffers_.pinned<long long>(1);
        dValues_ = buffers_.device<int>(n_);
        dTotal_ = buffers_.device<long long>(1);
        for (std::size_t index = 0; index < n_; ++index) {
            hValues_[index] = static_cast<int>((index * 17) % 101) - 50;
        }
        *hTotal_ = 0;
        kernelArgs_ = {&dValues_, &dTotal_, &countArg_};
        h2dDescriptors_.push_back(kernelpilotH2D(dValues_, hValues_, n_ * sizeof(int)));
        launchDescriptors_.push_back(kernelpilotKernel(
            reinterpret_cast<const void*>(kpArraySumKernel), dim3(1), dim3(256), kernelArgs_.data()));
        d2hDescriptors_.push_back(kernelpilotD2HResult<long long>(hTotal_, dTotal_, 1));
    }

    std::vector<KernelPilotCopy> h2dCopies() { return h2dDescriptors_; }
    std::vector<KernelPilotKernelLaunch> kernels() { return launchDescriptors_; }
    std::vector<KernelPilotCopy> d2hCopies() { return d2hDescriptors_; }
    std::vector<double> reference() {
        return {static_cast<double>(arraySum(hValues_, n_))};
    }
    void cleanup() { kernelpilotCheck(buffers_.release(), "buffer cleanup"); }
};
