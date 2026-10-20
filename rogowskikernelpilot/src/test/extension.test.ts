import * as assert from 'assert';
import { parseGpuBackendDecision } from '../benchmarkBackendDecision';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
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
});
