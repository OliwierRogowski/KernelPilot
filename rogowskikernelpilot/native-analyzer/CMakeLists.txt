cmake_minimum_required(VERSION 3.20)

project(KernelPilotNativeAnalyzer LANGUAGES C CXX)

find_package(LLVM REQUIRED CONFIG)
find_package(Clang REQUIRED CONFIG)

message(STATUS "LLVM version: ${LLVM_PACKAGE_VERSION}")
message(STATUS "LLVM directory: ${LLVM_DIR}")
message(STATUS "Clang directory: ${Clang_DIR}")

add_executable(kernelpilot-analyzer
    src/main.cpp
)

target_compile_features(kernelpilot-analyzer PRIVATE cxx_std_17)

target_include_directories(kernelpilot-analyzer SYSTEM PRIVATE
    ${LLVM_INCLUDE_DIRS}
    ${CLANG_INCLUDE_DIRS}
)

target_link_libraries(kernelpilot-analyzer PRIVATE clang-cpp LLVM)

install(TARGETS kernelpilot-analyzer
    RUNTIME DESTINATION bin
)