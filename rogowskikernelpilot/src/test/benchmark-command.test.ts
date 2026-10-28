/*  */import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { GpuBackendDecision } from '../benchmarkBackendDecision';

const benchmarkOutputLines: string[] = [];
let previousCodingModel: string | undefined;
let codingModelWasChanged = false;
let activeTestModel = '';
let originalWarningMessage: ((...args: unknown[]) => Promise<unknown>) | undefined;

suite('Benchmark command', () => {
	suiteSetup(async function () {
		// These end-to-end cases compile model output and execute it in a sandbox.
		// Opt in explicitly; ordinary unit-test runs must not auto-approve code execution.
		if (process.env.KERNELPILOT_RUN_MODEL_BENCHMARK_TESTS !== '1') {
			return this.skip();
		}
		const configuration = vscode.workspace.getConfiguration('kernelpilot');
		activeTestModel = process.env.KERNELPILOT_TEST_MODEL?.trim() ||
			configuration.get<string>('codingModel')?.trim() || '';
		let response: Response;
		try {
			response = await fetch('http://127.0.0.1:11434/api/tags', {
				signal: AbortSignal.timeout(2000)
			});
		} catch {
			return this.skip();
		}
		if (!response.ok) {
			return this.skip();
		}
		const data = await response.json() as { models?: Array<{ name?: string }> };
		if (!data.models?.some(model => model.name === activeTestModel)) {
			return this.skip();
		}
		previousCodingModel = configuration.inspect<string>('codingModel')?.globalValue;
		await configuration.update('codingModel', activeTestModel, vscode.ConfigurationTarget.Global);
		codingModelWasChanged = true;
		const testWindow = vscode.window as unknown as { showWarningMessage: (...args: unknown[]) => Promise<unknown> };
		originalWarningMessage = testWindow.showWarningMessage.bind(vscode.window);
		testWindow.showWarningMessage = async (...args) => {
			const message = String(args[0] ?? '');
			if (message.includes('will invoke a compiler on user/model-provided source')) {return 'Compile source';}
			if (message.startsWith('Run model-generated benchmark code?')) {return 'Run isolated benchmark';}
			return undefined;
		};
	});

	suiteTeardown(async () => {
		if (originalWarningMessage) {
			(vscode.window as unknown as { showWarningMessage: (...args: unknown[]) => Promise<unknown> }).showWarningMessage = originalWarningMessage;
		}
		if (!codingModelWasChanged) {
			return;
		}
		await vscode.workspace.getConfiguration('kernelpilot').update(
			'codingModel',
			previousCodingModel,
			vscode.ConfigurationTarget.Global
		);
	});

	test('benchmarks a main-only scalar reduction', async function () {
		this.timeout(600000);
		await benchmarkExample('sum_of_squares.cpp', 'scalar reduction');
	});

	test('benchmarks array sum reduction with verified CUDA phases', async function () {
		this.timeout(600000);
		await benchmarkExample('array_sum.cpp', 'array sum reduction', {
			requireCuda: true,
			expectedChecksums: [[64, -238], [128, -231], [256, -189]],
			expectedAdapterPath: path.resolve(__dirname, '../..', 'examples', 'array_sum.cuda-adapter.cuh')
		});
	});

	test('keeps the existing C++ bottleneck profiling path', async function () {
		this.timeout(600000);
		await benchmarkExample('array_sum.cpp', 'C++ bottleneck profile', {
			profileMode: true,
			requireCuda: true,
			expectedChecksums: [[64, -238], [128, -231], [257, -230]],
			expectedSizes: [64, 128, 257],
			expectedAdapterPath: path.resolve(__dirname, '../..', 'examples', 'array_sum.cuda-adapter.cuh')
		});
	});

	test('benchmarks matrix multiplication', async function () {
		this.timeout(600000);
		await benchmarkExample('matmul.cpp', 'matrix multiplication');
	});

	test('benchmarks vector addition', async function () {
		this.timeout(600000);
		await benchmarkExample('vector_add.cpp', 'vector addition');
	});

	test('benchmarks a one-dimensional stencil', async function () {
		this.timeout(600000);
		await benchmarkExample('stencil_1d.cpp', 'one-dimensional stencil');
	});

	test('attempts requested CUDA validation for a loop-carried checksum when hardware is available', async function () {
		this.timeout(600000);
		const decision = await benchmarkExample('sequential_checksum.cpp', 'sequential checksum');
		assert.ok(
			decision.decision === 'benchmark_cuda' || decision.source === 'unsupported',
			`The configured model ${activeTestModel} should either attempt CUDA validation or report unavailable hardware.`
		);
	});
});

interface ObservedBackendDecision extends GpuBackendDecision {
	source: string;
	model: string;
}

async function benchmarkExample(
	exampleName: string,
	description: string,
	options: { profileMode?: boolean; requireCuda?: boolean; expectedChecksums?: Array<[number, number]>; expectedSizes?: [number, number, number]; expectedAdapterPath?: string } = {}
): Promise<ObservedBackendDecision> {
	const outputStart = benchmarkOutputLines.length;
	const example = vscode.Uri.file(path.join(
		path.resolve(__dirname, '../..'),
		'examples',
		exampleName
	));
	const document = await vscode.workspace.openTextDocument(example);
	await vscode.window.showTextDocument(document);
	let commandError = '';
	const windowApi = vscode.window as unknown as {
		createOutputChannel: (name: string, options?: { log: boolean }) => vscode.OutputChannel;
	};
	const originalCreateOutputChannel = windowApi.createOutputChannel.bind(vscode.window);
	windowApi.createOutputChannel = (name, options) => {
		const channel = originalCreateOutputChannel(name, options);
		const appendLine = channel.appendLine.bind(channel);
		channel.appendLine = value => {
			benchmarkOutputLines.push(value);
			appendLine(value);
		};
		return channel;
	};
	const originalShowErrorMessage = vscode.window.showErrorMessage.bind(vscode.window);
	(vscode.window as unknown as { showErrorMessage: typeof vscode.window.showErrorMessage }).showErrorMessage =
		(message: string, ...items: unknown[]) => {
			commandError = message;
			return originalShowErrorMessage(message, ...items as never[]);
		};
	try {
		await vscode.commands.executeCommand(options.profileMode ? 'rogowskikernelpilot.profileBottlenecks' : 'rogowskikernelpilot.benchmark');
	} finally {
		windowApi.createOutputChannel = originalCreateOutputChannel;
		(vscode.window as unknown as { showErrorMessage: typeof vscode.window.showErrorMessage }).showErrorMessage =
			originalShowErrorMessage;
	}

	const outputLines = benchmarkOutputLines.slice(outputStart);
	const decisionLine = outputLines.find(line => line.startsWith('Backend action (rule):')) ?? '';
	const decisionMatch = decisionLine.match(/Backend action \(rule\): (cpu_only|benchmark_cuda); confidence=not applicable; source=(user-requested|capability-check); (.+)/);
	const modelLine = outputLines.find(line => line.startsWith('Model backend recommendation:')) ?? '';
	const modelMatch = modelLine.match(/Model backend recommendation: (cpu_only|benchmark_cuda) from ([^;]+); confidence ([\d.]+)/);
	assert.ok(Boolean(decisionMatch) && outputLines.some(line => /Collected (15|33) timing samples across 3 input sizes\./.test(line)),
		[commandError, ...outputLines].filter(Boolean).join('\n') || `Benchmark did not complete for ${description}.`);
	if (options.requireCuda) {
		if (options.expectedAdapterPath) {
			assert.ok(outputLines.some(line => line.includes(`adjacent user-authored fragment ${options.expectedAdapterPath}`)),
				`The adjacent adapter path and generic-runner provenance were not reported.\n${outputLines.join('\n')}`);
		}
		assert.strictEqual(decisionMatch?.[1], 'benchmark_cuda', `CUDA validation is required for ${description}.`);
		const checksumLine = outputLines.find(line => line.startsWith('CUDA verification checksums:')) ?? '';
		const checksumMatch = checksumLine.match(/^CUDA verification checksums: (.+)\.$/);
		assert.ok(checksumMatch, `CUDA verification checksums are missing for ${description}.\n${outputLines.join('\n')}`);
		const checksums = checksumMatch![1].split(', ').map(entry => {
			const match = entry.match(/^(\d+)=(-?\d+)$/);
			assert.ok(match, `Malformed CUDA verification checksum: ${entry}`);
			return [Number(match![1]), Number(match![2])] as [number, number];
		});
		assert.deepStrictEqual(checksums, options.expectedChecksums, `CUDA verification sums did not match the independent expected sums for ${description}.`);
		for (const phase of ['h2d', 'kernel', 'd2h', 'end_to_end']) {
			const line = outputLines.find(item => item.startsWith(`CUDA ${phase} medians:`)) ?? '';
			const expectedSizes = options.expectedSizes ?? [64, 128, 256];
			assert.match(line, new RegExp(`^CUDA ${phase} medians: ${expectedSizes[0]}=[\\d.]+ ms, ${expectedSizes[1]}=[\\d.]+ ms, ${expectedSizes[2]}=[\\d.]+ ms\\.$`),
				`CUDA ${phase} medians are missing or incomplete for ${description}.\n${outputLines.join('\n')}`);
		}
	}
	if (decisionMatch?.[1] === 'benchmark_cuda') {
		assert.strictEqual(decisionMatch[2], 'user-requested', 'The rule-driven user request is shown separately from model advice.');
		assert.ok(outputLines.some(line => line.includes('User-requested benchmark')));
		assert.ok(outputLines.some(line => line.includes('Paired CPU/GPU measurements were collected')),
			`CUDA was available but no verified phase measurements were collected for ${description}.\n${outputLines.join('\n')}`);
		assert.ok(outputLines.some(line => line.includes('CUDA kernel medians:')) &&
			outputLines.some(line => line.includes('CUDA h2d medians:')),
			`Verified CUDA phase medians are missing for ${description}.`);
	} else {
		assert.strictEqual(decisionMatch?.[1], 'cpu_only');
		assert.strictEqual(decisionMatch?.[2], 'capability-check');
		assert.ok(outputLines.some(line => line.includes('CUDA generation and measurement were skipped')));
		assert.ok(outputLines.some(line => line.includes('unavailable') || line.includes('did not report')));
		assert.ok(!outputLines.some(line => line.includes('Paired CPU/GPU measurements were collected')));
	}
	return {
		task: 'cuda_backend_selection',
		schema_version: 1,
		decision: decisionMatch![1] as GpuBackendDecision['decision'],
		confidence: modelMatch ? Number(modelMatch[3]) : 0,
		reason: decisionMatch![3],
		source: decisionMatch![2],
		model: modelMatch?.[2] ?? 'not available'
	};
}
