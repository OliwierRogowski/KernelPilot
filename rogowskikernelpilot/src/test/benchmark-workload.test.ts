import * as assert from 'assert';
import { benchmarkWorkloadSizes, detectFixedReductionElementCount, detectFixedWorkloadElementCount, detectSourceAlgorithmRepetitions, detectTransformReduceExecutionPolicy, isSupportedBenchmarkFile } from '../benchmarkWorkload';
import { withCudaRunnerWorkloadSizes } from '../genericCudaHarness';

suite('Fixed transform_reduce workload sizing', () => {
	test('accepts CUDA translation units for bottleneck profiling', () => {
		assert.strictEqual(isSupportedBenchmarkFile('/workspace/kernel.cu'), true);
		assert.strictEqual(isSupportedBenchmarkFile('/workspace/kernel.CU'), true);
		assert.strictEqual(isSupportedBenchmarkFile('/workspace/kernel.cpp'), true);
		assert.strictEqual(isSupportedBenchmarkFile('/workspace/kernel.py'), false);
	});

	test('recognizes the source element count and uses matched quarter, half, and full input sizes', () => {
		const source = 'constexpr std::size_t n = 1u << 24; std::transform_reduce(values.begin(), values.end(), 0.0, std::plus<>{}, [](float x) { return double(x) * x; });';
		assert.strictEqual(detectFixedReductionElementCount(source), 16_777_216);
		assert.deepStrictEqual(benchmarkWorkloadSizes(source), [4_194_304, 8_388_608, 16_777_216]);
	});

	test('uses the same explicit sizes in the CUDA runner', () => {
		const runner = withCudaRunnerWorkloadSizes('std::vector<int> sizes{64,128,256};', [4_194_304, 8_388_608, 16_777_216]);
		assert.ok(runner.includes('std::vector<int> sizes{4194304,8388608,16777216};'));
	});

	test('does not apply fixed reduction sizing to unrelated or dynamically sized workloads', () => {
		assert.strictEqual(detectFixedReductionElementCount('std::vector<float> values(n);'), undefined);
		assert.deepStrictEqual(benchmarkWorkloadSizes('std::vector<float> values(n);'), [64, 128, 256]);
	});

	test('detects source execution policy without silently substituting a default', () => {
		assert.strictEqual(detectTransformReduceExecutionPolicy('std::transform_reduce(std::execution::par, first, last, 0.0, plus, op);'), 'par');
		assert.strictEqual(detectTransformReduceExecutionPolicy('std::transform_reduce(first, last, 0.0, plus, op);'), undefined);
	});

	test('detects vector-backed fixed source sizes without requiring transform_reduce', () => {
		const source = 'constexpr std::size_t n = 1u << 24; std::vector<float> values(n);';
		assert.strictEqual(detectFixedWorkloadElementCount(source), 16_777_216);
		assert.deepStrictEqual(benchmarkWorkloadSizes(source), [4_194_304, 8_388_608, 16_777_216]);
	});

	test('uses integer workload sizes for odd fixed element counts', () => {
		const source = 'constexpr std::size_t n = 257; std::vector<int> values(n);';
		assert.deepStrictEqual(benchmarkWorkloadSizes(source), [64, 128, 257]);
	});

	test('keeps source algorithm repetitions distinct from timing sample count', () => {
		const source = 'constexpr int repetitions = 20; for (int iteration = 0; iteration < repetitions; ++iteration) { checksum += sumOfSquares(values); }';
		assert.strictEqual(detectSourceAlgorithmRepetitions(source), 20);
		assert.match(source, /repetitions = 20/);
	});
});
