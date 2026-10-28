import * as assert from 'assert';
import {
	classifyBenchmarkTarget,
	benchmarkTargetInputGuidance,
	isRuntimeDependentConstexprDiagnostic,
	validateBenchmarkAdapterFacts,
	type BenchmarkAnalysisFacts,
	type BenchmarkFunctionFacts
} from '../benchmarkTarget';

function fn(name: string, facts: Partial<BenchmarkFunctionFacts> = {}): BenchmarkFunctionFacts {
	return {
		name, returnType: 'int', parameters: name === 'kernelpilotRunTarget' ? [{ name: 'workloadSize', type: 'size_t' }] : [], line: 1, loops: [], conditions: [], calls: [],
		...facts
	};
}

function analysis(file: string, functions: BenchmarkFunctionFacts[]): BenchmarkAnalysisFacts {
	return { file, functions };
}

suite('Benchmark target selection and adapter AST validation', () => {
	test('recognizes the actual Clang diagnostic for constexpr initialized by workloadSize', () => {
		const diagnostic = "benchmark.cpp:7:32: error: constexpr variable 'n' must be initialized by a constant expression\n    constexpr std::size_t n = workloadSize;";
		assert.strictEqual(isRuntimeDependentConstexprDiagnostic(diagnostic), true);
		assert.strictEqual(isRuntimeDependentConstexprDiagnostic('constexpr std::size_t n = 64;'), false);
	});

	test('bounds matrix multiplication benchmark inputs to prevent int overflow', () => {
		const target = classifyBenchmarkTarget(analysis('matmul.cpp', [
			fn('main', { calls: [{ name: 'matrixMultiplicationCPU', line: 20, insideLoop: false }] }),
			fn('matrixMultiplicationCPU', {
				parameters: [
					{ name: 'rowsA', type: 'int' }, { name: 'columnsA', type: 'int' }, { name: 'matrixA', type: 'int*' },
					{ name: 'rowsB', type: 'int' }, { name: 'columnsB', type: 'int' }, { name: 'matrixB', type: 'int*' }
				],
				loops: [{ type: 'FOR', line: 8, reads: ['matrixA', 'matrixB'], writes: ['matrixC'], indexedReads: ['matrixA', 'matrixB'], indexedWrites: ['matrixC'] }]
			})
		]));
		assert.strictEqual(target.kind, 'function');
		if (target.kind !== 'function') {return;}
		assert.strictEqual(target.functionName, 'matrixMultiplicationCPU');
		const guidance = benchmarkTargetInputGuidance(target);
		assert.match(guidance, /square n×n matrices with n = workloadSize/);
		assert.match(guidance, /A elements are 0\/1 and B elements are 0\/1\/2/);
		assert.match(guidance, /A\[r\*n\+k\] with \(7\*r\+3\*k\+1\)%2/);
		assert.match(guidance, /B\[k\*n\+c\] with \(5\*k\+c\+1\)%3/);
		assert.match(guidance, /largest n=256/);
		assert.match(guidance, /exact sum of all elements/);
	});

	test('A: selects and requires a call to the source computation function', () => {
		const source = analysis('sum.c', [
			fn('main', { calls: [{ name: 'compute_sum', line: 8, insideLoop: false }] }),
			fn('compute_sum', { loops: [{ type: 'FOR', line: 3, reads: ['input'], writes: ['sum'], indexedReads: ['input'], indexedWrites: [] }] })
		]);
		const target = classifyBenchmarkTarget(source);
		assert.strictEqual(target.kind, 'function');
		if (target.kind !== 'function') {return;}
		assert.strictEqual(target.functionName, 'compute_sum');
		const adapter = analysis('generated.c', [fn('kernelpilotRunTarget', { calls: [{ name: 'compute_sum', line: 2, insideLoop: false }] })]);
		assert.strictEqual(validateBenchmarkAdapterFacts(adapter, target, source), undefined);
		const fakeNameOnly = analysis('generated.c', [fn('kernelpilotRunTarget')]);
		assert.match(validateBenchmarkAdapterFacts(fakeNameOnly, target, source) ?? '', /computation|AST-visible call/);
	});

	test('B: recognizes a transform_reduce algorithm in main despite lambda AST functions', () => {
		const source = analysis('reduce.cpp', [
			fn('main', { calls: [{ name: 'transform_reduce', line: 12, insideLoop: false }] }),
			fn('operator()', { calls: [{ name: 'operator*', line: 10, insideLoop: false }] })
		]);
		const target = classifyBenchmarkTarget(source);
		assert.strictEqual(target.kind, 'main');
		const faithful = analysis('generated.cpp', [fn('kernelpilotRunTarget', { calls: [{ name: 'transform_reduce', line: 2, insideLoop: false }] })]);
		const sourceText = 'int main(){ auto op = [](float value) { return value * value; }; return std::transform_reduce(x.begin(), x.end(), 0.0, std::plus<>{}, op); }';
		const faithfulAdapter = 'double kernelpilotRunTarget(size_t n){ auto op = [](float value) { return value * value; }; return std::transform_reduce(x.begin(), x.end(), 0.0, std::plus<>{}, op); }';
		assert.strictEqual(validateBenchmarkAdapterFacts(faithful, target, source, sourceText, faithfulAdapter), undefined);
		const changedLambda = 'double kernelpilotRunTarget(size_t n){ auto op = [](float value) { return value + value; }; return std::transform_reduce(x.begin(), x.end(), 0.0, std::plus<>{}, op); }';
		assert.match(validateBenchmarkAdapterFacts(faithful, target, source, sourceText, changedLambda) ?? '', /changed or omitted a source lambda/);
		const policySource = `${sourceText.replace('int main()', '#include <execution>\nint main()').replace('std::transform_reduce(', 'std::transform_reduce(std::execution::par, ')}`;
		const policyAdapter = `${faithfulAdapter.replace('std::transform_reduce(', 'std::transform_reduce(std::execution::par, ')}`;
		assert.strictEqual(validateBenchmarkAdapterFacts(faithful, target, source, policySource, policyAdapter), undefined);
		assert.match(validateBenchmarkAdapterFacts(faithful, target, source, policySource, faithfulAdapter) ?? '', /omitted the original std::execution::par policy/);
		const unrelated = analysis('generated.cpp', [fn('kernelpilotRunTarget', { calls: [{ name: 'sum_of_squares', line: 2, insideLoop: false }] })]);
		assert.match(validateBenchmarkAdapterFacts(unrelated, target, source) ?? '', /does not invoke the source algorithm/);
	});

	test('C: follows main call dependencies and rejects ambiguous equally-scored targets', () => {
		const source = analysis('multi.cpp', [
			fn('main', { calls: [{ name: 'setup', line: 10, insideLoop: false }] }),
			fn('setup', { calls: [{ name: 'matrix_multiply', line: 5, insideLoop: false }] }),
			fn('matrix_multiply', { loops: [{ type: 'FOR', line: 2, reads: ['a', 'b'], writes: ['c'], indexedReads: ['a', 'b'], indexedWrites: ['c'] }] }),
			fn('logging_helper', { loops: [{ type: 'FOR', line: 14, reads: [], writes: [], indexedReads: [], indexedWrites: [] }] })
		]);
		const target = classifyBenchmarkTarget(source);
		assert.strictEqual(target.kind, 'function');
		if (target.kind === 'function') {assert.strictEqual(target.functionName, 'matrix_multiply');}
		const ambiguous = analysis('ambiguous.cpp', [
			fn('main', { calls: [{ name: 'first', line: 1, insideLoop: false }, { name: 'second', line: 2, insideLoop: false }] }),
			fn('first', { loops: [{ type: 'FOR', line: 3, reads: ['a'], writes: ['b'], indexedReads: ['a'], indexedWrites: ['b'] }] }),
			fn('second', { loops: [{ type: 'FOR', line: 4, reads: ['a'], writes: ['b'], indexedReads: ['a'], indexedWrites: ['b'] }] })
		]);
		const ambiguousTarget = classifyBenchmarkTarget(ambiguous);
		assert.strictEqual(ambiguousTarget.kind, 'unsupported');
	});

	test('D: requires an AST-visible call to the actual CUDA kernel entry', () => {
		const source = analysis('vector_add.cu', [
			fn('main', { calls: [{ name: 'vector_add_kernel', line: 20, insideLoop: false }] }),
			fn('vector_add_kernel', { loops: [{ type: 'FOR', line: 4, reads: ['a', 'b'], writes: ['c'], indexedReads: ['a', 'b'], indexedWrites: ['c'] }] })
		]);
		const target = classifyBenchmarkTarget(source);
		assert.strictEqual(target.kind, 'function');
		if (target.kind !== 'function') {return;}
		assert.strictEqual(target.functionName, 'vector_add_kernel');
		const actualKernelLaunch = analysis('generated.cu', [fn('kernelpilotRunTarget', { calls: [{ name: 'vector_add_kernel', line: 2, insideLoop: false }] })]);
		assert.strictEqual(validateBenchmarkAdapterFacts(actualKernelLaunch, target, source), undefined);
		const cpuSubstitute = analysis('generated.cu', [fn('kernelpilotRunTarget', { calls: [{ name: 'cpu_vector_add', line: 2, insideLoop: false }] })]);
		assert.match(validateBenchmarkAdapterFacts(cpuSubstitute, target, source) ?? '', /AST-visible call/);
	});

	test('validates that a fixed vector workload size and source initializer reach the selected CPU function', () => {
		const targetFunction = fn('sumOfSquares', { parameters: [{ name: 'values', type: 'const std::vector<float> &' }] });
		const original = analysis('source.cpp', [fn('main'), targetFunction]);
		const target = { kind: 'function' as const, functionName: 'sumOfSquares', candidates: [targetFunction] };
		const source = 'constexpr std::size_t n = 1u << 24; std::vector<float> values(n); for (std::size_t i=0; i<n; ++i) { values[i] = static_cast<float>(i % 100) / 100.0f; }';
		const good = 'double kernelpilotRunTarget(std::size_t workloadSize) { std::vector<float> values(workloadSize); for (std::size_t i=0; i<workloadSize; ++i) { values[i] = static_cast<float>(i % 100) / 100.0f; } return sumOfSquares(values); }';
		const adapterFacts = analysis('adapter.cpp', [fn('kernelpilotRunTarget', { calls: [{ name: 'sumOfSquares', line: 2, insideLoop: false }] })]);
		assert.strictEqual(validateBenchmarkAdapterFacts(adapterFacts, target, original, source, good), undefined);
		const wrongSize = good.replace('values(workloadSize)', 'values(256)');
		assert.match(validateBenchmarkAdapterFacts(adapterFacts, target, original, source, wrongSize) ?? '', /source initializer/);
	});
});
