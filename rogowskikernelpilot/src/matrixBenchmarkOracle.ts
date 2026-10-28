export const matrixMultiplicationTargetName = 'matrixMultiplicationCPU';

export function isMatrixMultiplicationTarget(targetName: string | undefined): boolean {
	return targetName === matrixMultiplicationTargetName;
}

/** Wrap the user's implementation and add an independent exact oracle for its benchmark adapter. */
export function buildMatrixBenchmarkTranslationUnit(
	prelude: string,
	source: string,
	adapter: string,
	driver: string
): string {
	return `${prelude}\n#define main kernelpilot_original_main\n#define matrixMultiplicationCPU kernelpilotUserMatrixMultiplicationCPU\n${source}\n#undef matrixMultiplicationCPU\n#undef main\n${buildMatrixOracleSupport()}\n${adapter}\n${driver}\n`;
}

export function buildMatrixOraclePreflightCall(): string {
	return 'kernelpilotRunMatrixOraclePreflight(kernelpilot_runner);';
}

export function buildMatrixBenchmarkTimingDriver(): string {
	return `
static volatile long long kernelpilot_matrix_sink = 0;
static double (* volatile kernelpilot_runner)(std::size_t) = kernelpilotRunTarget;
using KernelPilotMatrixFunction = std::vector<int> (*)(int, int, int*, int, int, int*);
static KernelPilotMatrixFunction volatile kernelpilot_matrix_runner = &kernelpilotUserMatrixMultiplicationCPU;
int main() {
    ${buildMatrixOraclePreflightCall()}
    const std::size_t sizes[] = {70, 128, 256};
    for (std::size_t n : sizes) {
        std::vector<int> matrixA(n * n);
        std::vector<int> matrixB(n * n);
        for (std::size_t row = 0; row < n; ++row) {
            for (std::size_t column = 0; column < n; ++column) {
                matrixA[row * n + column] = static_cast<int>((7 * row + 3 * column + 1) % 2);
                matrixB[row * n + column] = static_cast<int>((5 * row + column + 1) % 3);
            }
        }
        const std::vector<int> expected = kernelpilotMatrixOracleReference(n, matrixA.data(), matrixB.data());
        const long long expectedChecksum = kernelpilotMatrixChecksum(expected);
        const std::vector<int> warmup = kernelpilot_matrix_runner(
            static_cast<int>(n), static_cast<int>(n), matrixA.data(),
            static_cast<int>(n), static_cast<int>(n), matrixB.data());
        if (warmup != expected || kernelpilotMatrixChecksum(warmup) != expectedChecksum) {
            throw std::runtime_error("Matrix benchmark: warmup result differs from the exact oracle.");
        }
        kernelpilot_matrix_sink = expectedChecksum;

        for (int sample = 0; sample < 5; ++sample) {
            const auto start = std::chrono::steady_clock::now();
            const std::vector<int> result = kernelpilot_matrix_runner(
                static_cast<int>(n), static_cast<int>(n), matrixA.data(),
                static_cast<int>(n), static_cast<int>(n), matrixB.data());
            const auto stop = std::chrono::steady_clock::now();
            const double elapsedMs = std::chrono::duration<double, std::milli>(stop - start).count();
            if (!(elapsedMs > 0.0)) {
                std::cerr << "KernelPilot timer returned a non-positive interval.\\n";
                return 3;
            }
            if (result != expected) {
                throw std::runtime_error("Matrix benchmark: timed target result differs from the exact oracle.");
            }
            const long long checksum = kernelpilotMatrixChecksum(result);
            if (checksum != expectedChecksum) {
                throw std::runtime_error("Matrix benchmark: timed result checksum differs from the exact oracle.");
            }
            kernelpilot_matrix_sink = checksum;
            std::cout << "KP_BENCH," << n << "," << std::fixed << std::setprecision(9) << elapsedMs << "\\n";
        }
    }
    return 0;
}
`;
}

function buildMatrixOracleSupport(): string {
	return `
static std::size_t kernelpilot_matrix_expected_n = 0;
static std::size_t kernelpilot_matrix_target_calls = 0;
static double kernelpilot_matrix_expected_checksum = 0.0;
static bool kernelpilot_matrix_oracle_active = true;

static void kernelpilotValidateMatrixInputs(std::size_t n, int* matrixA, int* matrixB) {
    if (n == 0 || n > 256 || matrixA == nullptr || matrixB == nullptr) {
        throw std::runtime_error("Matrix oracle: invalid dimensions or storage.");
    }
    for (std::size_t row = 0; row < n; ++row) {
        for (std::size_t column = 0; column < n; ++column) {
            const int expectedA = static_cast<int>((7 * row + 3 * column + 1) % 2);
            const int expectedB = static_cast<int>((5 * row + column + 1) % 3);
            const std::size_t index = row * n + column;
            if (matrixA[index] != expectedA || matrixB[index] != expectedB) {
                throw std::runtime_error("Matrix oracle: adapter inputs do not match the required deterministic pattern.");
            }
        }
    }
}

static std::vector<int> kernelpilotMatrixOracleReference(std::size_t n, int* matrixA, int* matrixB) {
    std::vector<int> expected(n * n, 0);
    for (std::size_t row = 0; row < n; ++row) {
        for (std::size_t column = 0; column < n; ++column) {
            int sum = 0;
            for (std::size_t k = 0; k < n; ++k) {
                sum += matrixA[row * n + k] * matrixB[k * n + column];
            }
            expected[row * n + column] = sum;
        }
    }
    return expected;
}

static long long kernelpilotMatrixChecksum(const std::vector<int>& values) {
    long long checksum = 0;
    for (int value : values) { checksum += value; }
    return checksum;
}

std::vector<int> matrixMultiplicationCPU(
    int rowsA, int columnsA, int* matrixA,
    int rowsB, int columnsB, int* matrixB) {
    if (!kernelpilot_matrix_oracle_active) {
        return kernelpilotUserMatrixMultiplicationCPU(
            rowsA, columnsA, matrixA, rowsB, columnsB, matrixB);
    }
    const std::size_t n = kernelpilot_matrix_expected_n;
    if (n == 0 || n > 256 || rowsA != static_cast<int>(n) ||
        columnsA != static_cast<int>(n) || rowsB != static_cast<int>(n) ||
        columnsB != static_cast<int>(n) || matrixA == nullptr || matrixB == nullptr) {
        throw std::runtime_error("Matrix oracle: adapter passed invalid dimensions or storage.");
    }
    kernelpilotValidateMatrixInputs(n, matrixA, matrixB);

    ++kernelpilot_matrix_target_calls;
    const std::vector<int> actual = kernelpilotUserMatrixMultiplicationCPU(
        rowsA, columnsA, matrixA, rowsB, columnsB, matrixB);
    const std::vector<int> expected = kernelpilotMatrixOracleReference(n, matrixA, matrixB);
    if (actual != expected) {
        throw std::runtime_error("Matrix oracle: target result differs from the independent integer reference.");
    }
    const long long checksum = kernelpilotMatrixChecksum(expected);
    if (checksum == 0) {
        throw std::runtime_error("Matrix oracle: deterministic test case produced a zero checksum.");
    }
    kernelpilot_matrix_expected_checksum = static_cast<double>(checksum);
    return actual;
}

static void kernelpilotRunMatrixOraclePreflight(double (*runner)(std::size_t)) {
    const std::size_t sizes[] = {2, 3, 5, 70, 128, 256};
    for (std::size_t n : sizes) {
        kernelpilot_matrix_expected_n = n;
        kernelpilot_matrix_target_calls = 0;
        kernelpilot_matrix_expected_checksum = 0.0;
        const double adapterChecksum = runner(n);
        if (kernelpilot_matrix_target_calls != 1) {
            throw std::runtime_error("Matrix oracle: adapter must make exactly one live target call per invocation.");
        }
        if (kernelpilot_matrix_expected_checksum == 0.0 ||
            adapterChecksum != kernelpilot_matrix_expected_checksum) {
            throw std::runtime_error("Matrix oracle: adapter checksum must equal the exact sum of the verified result elements.");
        }
    }
    kernelpilot_matrix_oracle_active = false;
}
`;
}
