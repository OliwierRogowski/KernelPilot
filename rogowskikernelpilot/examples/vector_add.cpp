#include <cstddef>
#include <iostream>
#include <vector>

void vectorAdd(
    const float* left,
    const float* right,
    float* result,
    std::size_t count)
{
    for (std::size_t index = 0; index < count; ++index)
    {
        result[index] = left[index] + right[index];
    }
}

int main()
{
    constexpr std::size_t count = 8;
    std::vector<float> left(count);
    std::vector<float> right(count);
    std::vector<float> result(count);

    for (std::size_t index = 0; index < count; ++index)
    {
        left[index] = static_cast<float>(index);
        right[index] = static_cast<float>(2 * index + 1);
    }

    vectorAdd(left.data(), right.data(), result.data(), count);

    for (float value : result)
    {
        std::cout << value << ' ';
    }
    std::cout << '\n';
    return 0;
}