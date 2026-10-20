/*  */import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { GpuBackendDecision } from '../benchmarkBackendDecision';

const benchmarkOutputLines: string[] = [];
let previousCodingModel: string | undefined;
let codingModelWasChanged = false;
let activeTestModel = '';

suite('Benchmark command', () => {
	suiteSetup(async function () {
		const configuration = vscode.workspace.getConfiguration('kernelpilot');
		activeTestModel = process.env.KERNELPILOT_TEST_MODEL?.trim() ||
			configuration.get<string>('codingModel')?.trim() || 'llama4:maverick';
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
	});

	suiteTeardown(async () => {
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

	test('keeps a loop-carried checksum on the CPU', async function () {
		this.timeout(600000);
		const decision = await benchmarkExample('sequential_checksum.cpp', 'sequential checksum');
		assert.strictEqual(
			decision.decision,
			'cpu_only',
			`The configured model ${activeTestModel} should reject CUDA for a loop-carried scalar dependency.`
		);
		assert.strictEqual(decision.source, 'model');
		assert.strictEqual(decision.model, activeTestModel);
	});
});

interface ObservedBackendDecision extends GpuBackendDecision {
	source: string;
	model: string;
}

async function benchmarkExample(exampleName: string, description: string): Promise<ObservedBackendDecision> {
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
		await vscode.commands.executeCommand('rogowskikernelpilot.benchmark');
	} finally {
		windowApi.createOutputChannel = originalCreateOutputChannel;
		(vscode.window as unknown as { showErrorMessage: typeof vscode.window.showErrorMessage }).showErrorMessage =
			originalShowErrorMessage;
	}

	const outputLines = benchmarkOutputLines.slice(outputStart);
	const decisionLine = outputLines.find(line => line.startsWith('AI backend decision (v1):')) ?? '';
	const decisionMatch = decisionLine.match(/AI backend decision \(v1\): (cpu_only|benchmark_cuda); source=(model|fallback|unsupported); model=([^;]+); confidence=([\d.]+); (.+)/);
		assert.ok(
			outputLines.some(line => line.includes('Collected 15 timing samples across 3 input sizes.')) &&
			Boolean(decisionMatch) &&
			(decisionMatch?.[1] === 'cpu_only'
				? outputLines.some(line => line.includes('CUDA generation and measurement were skipped')) &&
					!outputLines.some(line => line.includes('Paired CPU/GPU measurements were collected'))
				: outputLines.some(line => line.includes('Paired CPU/GPU measurements were collected')) &&
					outputLines.some(line => line.includes('wyniki CPU i GPU są zgodne')) &&
					!outputLines.some(line => line.includes('speedup 0.00x'))),
			[commandError, ...outputLines].filter(Boolean).join('\n') ||
			`Benchmark should return a valid model decision and follow its selected backend for ${description}.`
		);
	assert.strictEqual(decisionMatch![2], 'model', 'The decision must come from Llama 4 Maverick, not fallback logic.');
	assert.strictEqual(decisionMatch![3], activeTestModel, 'The benchmark must use the configured test model.');
	return {
		task: 'cuda_backend_selection',
		schema_version: 1,
		decision: decisionMatch![1] as GpuBackendDecision['decision'],
		confidence: Number(decisionMatch![4]),
		reason: decisionMatch![5],
		source: decisionMatch![2],
		model: decisionMatch![3]
	};
}