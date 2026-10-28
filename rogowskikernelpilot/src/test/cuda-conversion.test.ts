import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { buildCudaConversionRepairContext, compileCudaWithRepairs, extractMainOnlyTransformReduction, generateCudaImplementation, validateCudaImplementation } from '../cudaConversion';

const execFileAsync = promisify(execFile);

suite('CUDA conversion type and repair regressions', () => {
	test('accepts CUDA C++ in cpp/cuda fences and retries with exact validation feedback', async () => {
		const source = `const double sum_of_squares = std::transform_reduce(values.begin(), values.end(), 0.0, std::plus<>{}, [](float x) { return static_cast<double>(x) * x; });`;
		const invalid = `\`\`\`cpp\n__global__ void computeSumOfSquares(const float* d_values, float* d_result, std::size_t n) { if (threadIdx.x < n) d_result[threadIdx.x] = d_values[threadIdx.x] * d_values[threadIdx.x]; }\nvoid runCuda(std::vector<float>& values) { constexpr std::size_t n = values.size(); std::vector<double> d_result(n); cudaMalloc(&d_result.data(), n * sizeof(double)); cudaMemcpy(values.data(), d_result.data(), n * sizeof(double), cudaMemcpyDeviceToHost); cudaFree(d_result.data()); }\n\`\`\``;
		const valid = `\`\`\`cuda\n__global__ void computeSumOfSquares(const float* d_values, double* d_result, std::size_t n) { __shared__ double partial[128]; unsigned i = threadIdx.x; std::size_t globalIndex = blockIdx.x * blockDim.x + i; partial[i] = globalIndex < n ? static_cast<double>(d_values[globalIndex]) * d_values[globalIndex] : 0.0; __syncthreads(); for (unsigned stride = 64; stride; stride >>= 1) { if (i < stride) partial[i] += partial[i + stride]; __syncthreads(); } if (i == 0) atomicAdd(d_result, partial[0]); }\nvoid runCuda(std::vector<float>& values) { std::size_t n = values.size(); float* d_values = nullptr; double* d_result = nullptr; cudaMalloc(&d_values, n * sizeof(float)); cudaMalloc(&d_result, sizeof(double)); cudaMemset(d_result, 0, sizeof(double)); cudaMemcpy(d_values, values.data(), n * sizeof(float), cudaMemcpyHostToDevice); computeSumOfSquares<<<(n + 127) / 128, 128>>>(d_values, d_result, n); cudaDeviceSynchronize(); cudaMemcpy(&sum_of_squares, d_result, sizeof(double), cudaMemcpyDeviceToHost); cudaFree(d_values); cudaFree(d_result); }\n\`\`\``;
		const prompts: string[] = [];
		const attemptLog: Array<{ attempt: number; response: string; errors: string[] }> = [];
		const result = await generateCudaImplementation(source, 'base conversion prompt', async prompt => {
			prompts.push(prompt);
			return prompts.length === 1 ? invalid : valid;
		}, 3, (attempt, response, errors) => attemptLog.push({ attempt, response, errors }));
		assert.ok(result.includes('atomicAdd'));
		assert.equal(prompts.length, 2);
		assert.match(prompts[1], /Runtime-dependent values.*constexpr/);
		assert.match(prompts[1], /cudaMalloc must receive a separate device pointer/);
		assert.match(prompts[1], /scalar sum-of-squares reduction/);
		assert.ok(prompts[1].includes(invalid), 'retry must receive the actual rejected model response');
		assert.equal(attemptLog.length, 2);
		assert.ok(attemptLog[0].errors.length > 0);
		assert.deepStrictEqual(attemptLog[1].errors, []);
	});

	test('reports concrete CUDA conversion validation failure after controlled model retries', async () => {
		await assert.rejects(
			generateCudaImplementation('int main() { }', 'prompt', async () => '```cpp\nnot cuda\n```'),
			(error: Error) => {
				assert.match(error.message, /Missing a CUDA __global__ kernel/);
				assert.match(error.message, /Last response/);
				return true;
			}
		);
	});

	test('rejects a CUDA candidate that writes only the first square even if it synchronizes', () => {
		const source = `std::transform_reduce(values.begin(), values.end(), 0.0, std::plus<>{}, [](float x) { return static_cast<double>(x) * x; });`;
		const wrong = `__global__ void kernel(const float* d_values, double* d_result) { __syncthreads(); if (threadIdx.x == 0) d_result[0] = static_cast<double>(d_values[0]) * d_values[0]; } void runCuda() { cudaMalloc(nullptr, 4); cudaMemcpy(nullptr, nullptr, 0, cudaMemcpyHostToDevice); cudaDeviceSynchronize(); }`;
		assert.ok(validateCudaImplementation(source, wrong).some(error => /scalar sum-of-squares reduction/.test(error)));
	});

	test('does not reject a host result vector based on its variable name and accepts warp reduction evidence', () => {
		const source = `std::vector<float> d_result(32); std::transform_reduce(d_result.begin(), d_result.end(), 0.0, std::plus<>{}, [](float x) { return static_cast<double>(x) * x; });`;
		const code = `__global__ void sum(const float* input, double* output, unsigned n) { unsigned idx = blockIdx.x * blockDim.x + threadIdx.x; double value = idx < n ? static_cast<double>(input[idx]) * input[idx] : 0.0; for (int offset = 16; offset; offset >>= 1) value += __shfl_down_sync(0xffffffff, value, offset); if ((threadIdx.x & 31) == 0) atomicAdd(output, value); }
void compute(const std::vector<float>& d_result) { std::size_t n = d_result.size(); if (n == 0) return; float* deviceInput = nullptr; double* deviceOutput = nullptr; cudaMalloc(&deviceInput, n * sizeof(float)); cudaMalloc(&deviceOutput, sizeof(double)); cudaMemcpy(deviceInput, d_result.data(), n * sizeof(float), cudaMemcpyHostToDevice); cudaMemset(deviceOutput, 0, sizeof(double)); sum<<<(n + 31) / 32, 32>>>(deviceInput, deviceOutput, n); double hostResult; cudaMemcpy(&hostResult, deviceOutput, sizeof(double), cudaMemcpyDeviceToHost); cudaFree(deviceInput); cudaFree(deviceOutput); }`;
		assert.deepStrictEqual(validateCudaImplementation(source, code), []);
	});

	test('rejects passing an ordinary source vector host pointer directly to a CUDA kernel', () => {
		const source = `std::vector<float> input(16);`;
		const code = `__global__ void square(const float* x, double* y, int n) { if (threadIdx.x < n) atomicAdd(y, x[threadIdx.x] * x[threadIdx.x]); } void launchCuda(const std::vector<float>& input) { double* result = nullptr; cudaMalloc(&result, sizeof(double)); cudaMemset(result, 0, sizeof(double)); square<<<1, 32>>>(input.data(), result, input.size()); cudaMemcpy(&hostResult, result, sizeof(double), cudaMemcpyDeviceToHost); cudaFree(result); }`;
		assert.ok(validateCudaImplementation(source, code).some(error => /vector input.data\(\) directly/.test(error)));
	});

	test('rejects barriers under bounds branches and uninitialized shared lanes for partial blocks', () => {
		const source = `std::vector<float> input(1003); std::transform_reduce(input.begin(), input.end(), 0.0, std::plus<>{}, [](float x) { return static_cast<double>(x) * x; });`;
		const code = `__global__ void sum(const float* x, double* out, std::size_t n) { __shared__ double partial[256]; std::size_t i = blockIdx.x * blockDim.x + threadIdx.x; if (i < n) { partial[threadIdx.x] = static_cast<double>(x[i]) * x[i]; __syncthreads(); } for (int stride = 128; stride; stride >>= 1) { if (threadIdx.x < stride) partial[threadIdx.x] += partial[threadIdx.x + stride]; __syncthreads(); } if (threadIdx.x == 0) atomicAdd(out, partial[0]); } double sumCuda(const std::vector<float>& input) { double* d_out = nullptr; float* d_input = nullptr; cudaMalloc(&d_out, sizeof(double)); cudaMemset(d_out, 0, sizeof(double)); cudaMalloc(&d_input, input.size() * sizeof(float)); cudaMemcpy(d_input, input.data(), input.size() * sizeof(float), cudaMemcpyHostToDevice); sum<<<(input.size()+255)/256, 256>>>(d_input, d_out, input.size()); double out; cudaMemcpy(&out, d_out, sizeof(double), cudaMemcpyDeviceToHost); cudaFree(d_input); cudaFree(d_out); return out; }`;
		const errors = validateCudaImplementation(source, code);
		assert.ok(errors.some(error => /shared reduction array partial uninitialized/.test(error)));
		assert.ok(errors.some(error => /inside an input-bounds conditional/.test(error)));
	});

	test('extracts the real main-only transform reduction without copying the application entry point', async () => {
		const source = `#include <vector>\nint main() { std::vector<float> values(8); const double total = std::transform_reduce(values.begin(), values.end(), 0.0, std::plus<>{}, [](float x) { return static_cast<double>(x) * x; }); std::cout << total; return 0; }`;
		const extracted = extractMainOnlyTransformReduction(source);
		assert.match(extracted ?? '', /std::vector<float> values\(8\)/);
		assert.match(extracted ?? '', /std::transform_reduce/);
		assert.match(extracted ?? '', /return static_cast<double>\(x\) \* x/);
		assert.doesNotMatch(extracted ?? '', /int main|std::cout/);
	});

	test('repairs a float input and double result mismatch without suggesting a cast', () => {
		const source = `std::vector<float> values(n);\nconst double sum_of_squares = reduce(values);`;
		const diagnostic = `conversion.cu(59): error: argument of type "double *" is incompatible with parameter of type "float *"\nkernelSumOfSquares<<<numBlocks, blockSize>>>(d_values, d_result, n);`;
		const failedCode = `__global__ void kernelSumOfSquares(const float* d_values, float* d_result, std::size_t n) { /* body */ }\n` + '/* full failed adapter */\n'.repeat(1200);
		const context = buildCudaConversionRepairContext(source, diagnostic, failedCode);
		assert.match(context, /std::vector<float> values/);
		assert.match(context, /double sum_of_squares/);
		assert.match(context, /call passes double \*, while the callee expects float \*/);
		assert.match(context, /Do not cast the pointer/);
		assert.ok(context.includes(diagnostic), 'full NVCC diagnostic must reach the repair prompt');
		assert.ok(context.includes(failedCode), 'complete failed adapter must reach the repair prompt');
	});

	test('preserves double input and double accumulator declarations', () => {
		const context = buildCudaConversionRepairContext(
			'std::vector<double> values(n);\ndouble result = reduce(values);',
			'argument of type "float *" is incompatible with parameter of type "double *"',
			'__global__ void kernel(const double* values, double* result) {}'
		);
		assert.match(context, /std::vector<double> values/);
		assert.match(context, /double result/);
		assert.match(context, /call passes float \*, while the callee expects double \*/);
	});

	test('reproduces the reported double-pointer to float-pointer launch error and carries it into repair context', async function () {
		this.timeout(60000);
		const nvcc = process.env.KERNELPILOT_NVCC || 'nvcc';
		try { await execFileAsync(nvcc, ['--version'], { timeout: 5000 }); }
		catch { this.skip(); return; }
		const directory = await mkdtemp(path.join(os.tmpdir(), 'kernelpilot-pointer-mismatch-'));
		try {
			const sourcePath = path.join(directory, 'pointer-mismatch.cu');
			const source = '#include <cuda_runtime.h>\n#include <cstddef>\n#include <vector>\nstd::vector<float> values(16);\ndouble sum_of_squares = 0;\n';
			const badAddition = '__global__ void kernelSumOfSquares(const float* values, float* result, std::size_t n) {}\nvoid launch(float* d_values, double* d_result, std::size_t n) { kernelSumOfSquares<<<1, 128>>>(d_values, d_result, n); }\n';
			await writeFile(sourcePath, source + badAddition);
			let diagnostics = '';
			await assert.rejects(
				execFileAsync(nvcc, ['-std=c++17', '-c', sourcePath, '-o', path.join(directory, 'bad.o')],
					{ timeout: 60000, maxBuffer: 2 * 1024 * 1024 }),
				(error: unknown) => {
					const processError = error as { stderr?: string; message?: string };
					diagnostics = processError.stderr ?? processError.message ?? '';
					assert.match(diagnostics, /argument of type ["']double \*["'] is incompatible with parameter of type ["']float \*["']/);
					return true;
				}
			);
			const repairContext = buildCudaConversionRepairContext(source, diagnostics, badAddition);
			assert.ok(repairContext.includes(diagnostics));
			assert.match(repairContext, /std::vector<float> values/);
			assert.match(repairContext, /double sum_of_squares/);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test('passes complete NVCC diagnostics and the failed source to the repair, then compiles the repaired source', async () => {
		const initialCode = 'failed float/double adapter';
		const repairedCode = 'consistent float input and double result adapter';
		const fullDiagnostic = `conversion.cu(59): error: argument of type "double *" is incompatible with parameter of type "float *"\n${'compiler context line\n'.repeat(500)}`;
		const compileInputs: string[] = [];
		const repairInputs: Array<{ diagnostics: string; code: string; attempt: number }> = [];
		const result = await compileCudaWithRepairs(
			initialCode,
			async (code, attempt) => {
				compileInputs.push(`${attempt}:${code}`);
				if (attempt === 1) {
					const error = new Error('nvcc compilation failed') as Error & { stderr: string };
					error.stderr = fullDiagnostic;
					throw error;
				}
			},
			async (diagnostics, failedCode, nextAttempt) => {
				repairInputs.push({ diagnostics, code: failedCode, attempt: nextAttempt });
				return repairedCode;
			},
			error => typeof error === 'object' && error !== null && 'stderr' in error
				? String((error as { stderr: unknown }).stderr)
				: String(error)
		);
		assert.deepStrictEqual(repairInputs, [{ diagnostics: fullDiagnostic, code: initialCode, attempt: 2 }]);
		assert.deepStrictEqual(compileInputs, [`1:${initialCode}`, `2:${repairedCode}`]);
		assert.deepStrictEqual(result, { code: repairedCode, attempts: 2 });
	});

	for (const type of ['float', 'double'] as const) {
		test(`nvcc compiles a ${type} input buffer with a double reduction result and matching launch signature`, async function () {
			this.timeout(60000);
			const nvcc = process.env.KERNELPILOT_NVCC || 'nvcc';
			try { await execFileAsync(nvcc, ['--version'], { timeout: 5000 }); }
			catch { this.skip(); return; }
			const directory = await mkdtemp(path.join(os.tmpdir(), `kernelpilot-${type}-types-`));
			try {
				const sourcePath = path.join(directory, 'type-consistency.cu');
				const input = type === 'float' ? 'std::vector<float>' : 'std::vector<double>';
				const source = `#include <cuda_runtime.h>\n#include <cstddef>\n#include <vector>\n\n__global__ void kernelSumOfSquares(const ${type}* d_values, double* d_result, std::size_t n) {\n  const std::size_t i = blockIdx.x * blockDim.x + threadIdx.x;\n  if (i == 0 && n > 0) d_result[0] = static_cast<double>(d_values[0]) * d_values[0];\n}\n\nvoid launch(${input}& values, double* result) {\n  ${type}* d_values = nullptr;\n  double* d_result = nullptr;\n  const std::size_t n = values.size();\n  cudaMalloc(reinterpret_cast<void**>(&d_values), n * sizeof(${type}));\n  cudaMalloc(reinterpret_cast<void**>(&d_result), sizeof(double));\n  cudaMemcpy(d_values, values.data(), n * sizeof(${type}), cudaMemcpyHostToDevice);\n  kernelSumOfSquares<<<1, 128>>>(d_values, d_result, n);\n  cudaMemcpy(result, d_result, sizeof(double), cudaMemcpyDeviceToHost);\n  cudaFree(d_values);\n  cudaFree(d_result);\n}\n`;
				await writeFile(sourcePath, source);
				await execFileAsync(nvcc, ['-std=c++17', '-c', sourcePath, '-o', path.join(directory, 'type-consistency.o')],
					{ timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		});
	}
});
