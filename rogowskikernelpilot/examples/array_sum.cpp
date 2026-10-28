#include <cstddef>
#include <iostream>
#include <vector>

long long arraySum(const int* values, std::size_t count)
{
    long long sum = 0;
    for (std::size_t index = 0; index < count; ++index)
    {
        sum += values[index];
    }
    return sum;
}

int main()
{
    constexpr std::size_t count = 257;
    std::vector<int> values(count);
    for (std::size_t index = 0; index < count; ++index)
    {
        values[index] = static_cast<int>((index * 17) % 101) - 50;
    }

    std::cout << arraySum(values.data(), values.size()) << '\n';
    return 0;
}
