#include "protocol.hpp"

int main(int argc, char** argv) {
    try {
        const auto input = kernelpilotReadInput(kernelpilotInputPath(argc, argv));
        std::vector<double> output(input.size());
        for (std::size_t index = 0; index < input.size(); ++index) {output[index] = input[index] * 3.0 + 2.0;}
        kernelpilotWriteOutput(output);
        return 0;
    } catch (const std::exception& error) {std::cerr << error.what() << '\n'; return 2;}
}
