#include <cstddef>
#include <iostream>
#include <vector>

void stencil1D(const float* input, float* output, std::size_t count)
{
    for (std::size_t index = 0; index < count; ++index)
    {
        if (index == 0 || index + 1 == count)
        {
            output[index] = input[index];
        }
        else
        {
            output[index] = input[index - 1] * 0.25f +
                input[index] * 0.5f + input[index + 1] * 0.25f;
        }
    }
}

int main()
{
    constexpr std::size_t count = 8;
    std::vector<float> input(count);
    std::vector<float> output(count);
    for (std::size_t index = 0; index < count; ++index)
    {
        input[index] = static_cast<float>(index);
    }

    stencil1D(input.data(), output.data(), count);
    for (float value : output)
    {
        std::cout << value << ' ';
    }
    std::cout << '\n';
    return 0;
}