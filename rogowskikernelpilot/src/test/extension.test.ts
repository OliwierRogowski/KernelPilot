import * as assert from 'assert';
import { parseGpuBackendDecision, recordUserRequestedCudaAttempt, unavailableCudaComparison } from '../benchmarkBackendDecision';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { isSupportedBenchmarkFile } from '../benchmarkWorkload';
// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
	test('registers the bottleneck profiling command in the package manifest', () => {
		const manifest = require('../../package.json') as { contributes: { commands: Array<{ command: string; title: string }>; menus?: { 'editor/context'?: Array<{ command: string; when?: string }> } } };
		assert.ok(manifest.contributes.commands.some(command => command.command === 'rogowskikernelpilot.profileBottlenecks' && command.title === 'KernelPilot: Profile Bottlenecks'));
		const profileContext = manifest.contributes.menus?.['editor/context']?.find(item => item.command === 'rogowskikernelpilot.profileBottlenecks');
		assert.ok(profileContext?.when?.includes('cpp'));
		assert.ok(profileContext?.when?.includes('cuda-cpp'));
		assert.ok(profileContext?.when?.includes('resourceExtname == .cu'));
		assert.ok(profileContext?.when?.includes('resourceExtname == .cuh'));
		assert.ok(isSupportedBenchmarkFile('/workspace/kernel.cu'));
		assert.ok(isSupportedBenchmarkFile('/workspace/kernel.cuh'));
	});
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('parses the versioned CPU-only backend decision', () => {
		assert.deepStrictEqual(
			parseGpuBackendDecision('```json\n{"task":"cuda_backend_selection","schema_version":1,"decision":"cpu_only","confidence":0.94,"reason":"Loop-carried dependency prevents useful parallel execution."}\n```'),
			{
				task: 'cuda_backend_selection',
				schema_version: 1,
				decision: 'cpu_only',
				confidence: 0.94,
				reason: 'Loop-carried dependency prevents useful parallel execution.'
			}
		);
	});

	test('rejects unsupported backend-decision schemas', () => {
		assert.strictEqual(
			parseGpuBackendDecision('{"task":"cuda_backend_selection","schema_version":2,"decision":"cpu_only","confidence":1,"reason":"unsupported version"}'),
			undefined
		);
		assert.strictEqual(
			parseGpuBackendDecision('{"task":"cuda_backend_selection","schema_version":1,"decision":"cpu_only","confidence":3,"reason":"invalid confidence"}'),
			undefined
		);
	});

	test('keeps model recommendation separate from the user-requested fallback and its confidence', () => {
		const model = { task: 'cuda_backend_selection' as const, schema_version: 1 as const,
			decision: 'cpu_only' as const, confidence: 0.9, reason: 'Model has not measured CUDA.' };
		const recorded = recordUserRequestedCudaAttempt(model, 'muse-spark-1.3');
		assert.strictEqual(recorded.source, 'fallback');
		assert.strictEqual(recorded.confidence, 0);
		assert.deepStrictEqual(recorded.modelDecision, model);
		assert.strictEqual(recorded.decision, 'benchmark_cuda');
	});

	test('reports a missing CUDA comparison as unresolved without asserting CPU or GPU superiority', () => {
		const report = unavailableCudaComparison('CUDA adapter generation was truncated');
		assert.match(report, /comparison is unresolved/);
		assert.match(report, /no actual CUDA samples were collected/);
		assert.match(report, /hypotheses that require separate measurements/);
		assert.doesNotMatch(report, /keep the workload on CPU|do not run it on GPU/i);
	});
});
