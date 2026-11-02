#pragma once

#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

inline std::string kernelpilotInputPath(int argc, char** argv) {
    for (int index = 1; index + 1 < argc; ++index) {
        if (std::string(argv[index]) == "--kernelpilot-input") {return argv[index + 1];}
    }
    throw std::runtime_error("missing --kernelpilot-input <file>");
}

inline std::vector<double> kernelpilotReadInput(const std::string& file) {
    std::ifstream input(file);
    std::string line;
    if (!std::getline(input, line) || line != "KP_INPUT_V1") {throw std::runtime_error("unsupported KernelPilot input protocol");}
    std::vector<double> values;
    std::size_t expectedCount = 0;
    while (std::getline(input, line)) {
        if (line.rfind("count,", 0) == 0) {expectedCount = static_cast<std::size_t>(std::stoull(line.substr(6)));}
        else if (line.rfind("value,", 0) == 0) {
            const auto first = line.find(',', 6);
            if (first == std::string::npos) {throw std::runtime_error("malformed input value record");}
            const auto index = static_cast<std::size_t>(std::stoull(line.substr(6, first - 6)));
            if (index != values.size()) {throw std::runtime_error("input indices are not contiguous");}
            values.push_back(std::stod(line.substr(first + 1)));
        }
    }
    if (!input.eof() || values.size() != expectedCount) {throw std::runtime_error("input count does not match value records");}
    return values;
}

inline void kernelpilotWriteOutput(const std::vector<double>& values) {
    std::cout << std::setprecision(17) << "KP_RESULT_V1,float64," << values.size() << '\n';
    for (std::size_t index = 0; index < values.size(); ++index) {std::cout << "KP_VALUE," << index << ',' << values[index] << '\n';}
}
