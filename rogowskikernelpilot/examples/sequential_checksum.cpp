#include <cstddef>
#include <cstdint>
#include <iostream>

std::uint32_t sequentialChecksum(std::size_t iterations, std::uint32_t seed)
{
    std::uint32_t state = seed;
    for (std::size_t index = 0; index < iterations; ++index)
    {
        state = state * 1664525u + 1013904223u + static_cast<std::uint32_t>(index);
    }
    return state;
}

int main()
{
    std::cout << sequentialChecksum(64, 7u) << '\n';
    return 0;
}