import * as assert from 'assert';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { buildMatrixBenchmarkTimingDriver, buildMatrixBenchmarkTranslationUnit, buildMatrixOraclePreflightCall } from '../matrixBenchmarkOracle';

const execFileAsync = promisify(execFile);

const prelude = `
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <exception>
#include <iomanip>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>
`;

const correctTarget = `
std::vector<int> matrixMultiplicationCPU(int rowsA, int columnsA, int* matrixA,
    int rowsB, int columnsB, int* matrixB) {
    std::vector<int> result(static_cast<std::size_t>(rowsA) * columnsB, 0);
    for (int row = 0; row < rowsA; ++row) {
        for (int column = 0; column < columnsB; ++column) {
            for (int k = 0; k < columnsA; ++k) {
                result[static_cast<std::size_t>(row) * columnsB + column] +=
                    matrixA[static_cast<std::size_t>(row) * columnsA + k] *
                    matrixB[static_cast<std::size_t>(k) * columnsB + column];
            }
        }
    }
    return result;
}
int main() { return 0; }
`;

const adapterSetup = `
static double runMatrix(std::size_t workloadSize, bool callTarget, bool returnZero) {
    const std::size_t n = workloadSize;
    std::vector<int> a(n * n), b(n * n);
    for (std::size_t row = 0; row < n; ++row) {
        for (std::size_t column = 0; column < n; ++column) {
            a[row * n + column] = static_cast<int>((7 * row + 3 * column + 1) % 2);
            b[row * n + column] = static_cast<int>((5 * row + column + 1) % 3);
        }
    }
    if (callTarget) {
        const auto result = matrixMultiplicationCPU(static_cast<int>(n), static_cast<int>(n), a.data(),
            static_cast<int>(n), static_cast<int>(n), b.data());
        if (!returnZero) {
            long long checksum = 0;
            for (int value : result) { checksum += value; }
            return static_cast<double>(checksum);
        }
    }
    return returnZero ? 0.0 : 1.0;
}
`;

function program(adapterBody: string, target = correctTarget): string {
	const adapter = `double kernelpilotRunTarget(std::size_t workloadSize) { ${adapterBody} }`;
	const runner = `
static double (* volatile kernelpilot_runner)(std::size_t) = kernelpilotRunTarget;
int main() { ${buildMatrixOraclePreflightCall()} return 0; }
`;
	return buildMatrixBenchmarkTranslationUnit(prelude, target, adapterSetup + adapter, runner);
}

async function compileAndRun(
	directory: string,
	name: string,
	source: string,
	optimizationFlags = ['-O0']
): Promise<string> {
	const sourcePath = path.join(directory, `${name}.cpp`);
	const executablePath = path.join(directory, name);
	await writeFile(sourcePath, source, 'utf8');
	await execFileAsync('g++', ['-std=c++17', ...optimizationFlags, sourcePath, '-o', executablePath], { timeout: 30000 });
	const { stdout } = await execFileAsync(executablePath, [], { timeout: 10000 });
	return stdout;
}

suite('Matrix multiplication benchmark runtime oracle', () => {
	test('accepts the target algorithm and rejects a fake checksum, wrong result, and non-live target call', async function () {
		this.timeout(30000);
		const directory = await mkdtemp(path.join(os.tmpdir(), 'kernelpilot-matrix-oracle-'));
		try {
			await compileAndRun(directory, 'valid', program('return runMatrix(workloadSize, true, false);'));
			await assert.rejects(
				compileAndRun(directory, 'fake-checksum', program('return runMatrix(workloadSize, true, true);')),
				/Matrix oracle: adapter checksum must equal/
			);
			const wrongTarget = correctTarget.replace('return result;', 'return std::vector<int>(result.size(), 0);');
			await assert.rejects(
				compileAndRun(directory, 'wrong-result', program('return runMatrix(workloadSize, true, false);', wrongTarget)),
				/Matrix oracle: target result differs/
			);
			const transposedTarget = correctTarget.replace('matrixB[static_cast<std::size_t>(k) * columnsB + column]', 'matrixB[static_cast<std::size_t>(column) * columnsB + k]');
			await assert.rejects(
				compileAndRun(directory, 'transposed-index', program('return runMatrix(workloadSize, true, false);', transposedTarget)),
				/Matrix oracle: target result differs/
			);
			await assert.rejects(
				compileAndRun(directory, 'dead-target-call', program('return runMatrix(workloadSize, false, false);')),
				/Matrix oracle: adapter must make exactly one live target call/
			);
			const productionDriver = buildMatrixBenchmarkTimingDriver();
			const timingGuard = `
static volatile std::size_t kernelpilot_timed_adapter_calls = 0;
struct KernelPilotAdapterCallGuard {
    ~KernelPilotAdapterCallGuard() { if (kernelpilot_timed_adapter_calls != 0) { std::abort(); } }
} kernelpilot_adapter_call_guard;
`;
			const productionAdapter = `${timingGuard}${adapterSetup}
double kernelpilotRunTarget(std::size_t workloadSize) {
    if (!kernelpilot_matrix_oracle_active) { ++kernelpilot_timed_adapter_calls; }
    return runMatrix(workloadSize, true, false);
}`;
			const countedTarget = correctTarget
				.replace('std::vector<int> matrixMultiplicationCPU', 'static std::size_t kernelpilot_original_call_count = 0;\nstd::vector<int> matrixMultiplicationCPU')
				.replace('    std::vector<int> result', '    ++kernelpilot_original_call_count;\n    std::vector<int> result')
				.replace('int main() { return 0; }', `
struct KernelPilotTargetCallGuard {
    ~KernelPilotTargetCallGuard() { if (kernelpilot_original_call_count != 24) { std::abort(); } }
} kernelpilot_target_call_guard;
int main() { return 0; }
`);
			const timingOutput = await compileAndRun(directory, 'production-driver',
				buildMatrixBenchmarkTranslationUnit(prelude, countedTarget, productionAdapter,
					productionDriver), ['-O3', '-DNDEBUG']);
			const timingRecords = timingOutput.split(/\r?\n/).filter(line => /^KP_BENCH,/.test(line));
			assert.strictEqual(timingRecords.length, 15);
			assert.deepStrictEqual(timingRecords.map(line => Number(line.split(',')[1])),
				[70, 70, 70, 70, 70, 128, 128, 128, 128, 128, 256, 256, 256, 256, 256]);
		assert.ok(timingRecords.every(line => Number(line.split(',')[2]) > 0));
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
