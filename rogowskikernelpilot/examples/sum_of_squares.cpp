#include <cstddef>
#include <execution>
#include <functional>
#include <iostream>
#include <numeric>
#include <vector>

int main() {
    constexpr std::size_t n = 1u << 24;
    std::vector<float> values(n);

    for (std::size_t i = 0; i < n; ++i) {
        values[i] = static_cast<float>(i % 100) / 100.0f;
    }

    const double sum_of_squares = std::transform_reduce(
        std::execution::par,
        values.begin(),
        values.end(),
        0.0,
        std::plus<>{},
        [](float value) {
            return static_cast<double>(value) * value;
        });

    std::cout << "Suma kwadratow: " << sum_of_squares << '\n';
    return 0;
}