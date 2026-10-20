void process(int n, int* input, int* output) {
    int sum = 0;

    for (int i = 0; i < n; ++i) {
        output[i] = input[i] * 2;
        sum += input[i];
    }

    while (sum < 100) {
        ++sum;
    }
}

int main() {
    int input[10] = {};
    int output[10] = {};
    process(10, input, output);
    return output[0];
}