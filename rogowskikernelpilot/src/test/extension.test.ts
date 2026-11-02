import * as assert from 'assert';
import { parseGpuBackendDecision, recordUserRequestedCudaAttempt, unavailableCudaComparison } from '../benchmarkBackendDecision';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { mkdtemp, rm, writeFile, chmod, access, readdir, readFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isSupportedBenchmarkFile } from '../benchmarkWorkload';
// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
	test('registers the bottleneck profiling command in the package manifest', () => {
		const manifest = require('../../package.json') as { contributes: { commands: Array<{ command: string; title: string }>; menus?: { 'editor/context'?: Array<{ command: string; when?: string }> }; configuration: { properties: Record<string, { default: unknown }> } } };
		assert.ok(manifest.contributes.commands.some(command => command.command === 'rogowskikernelpilot.profileBottlenecks' && command.title === 'KernelPilot: Profile Bottlenecks'));
		const profileContext = manifest.contributes.menus?.['editor/context']?.find(item => item.command === 'rogowskikernelpilot.profileBottlenecks');
		assert.ok(profileContext?.when?.includes('cpp'));
		assert.ok(profileContext?.when?.includes('cuda-cpp'));
		assert.ok(profileContext?.when?.includes('resourceExtname == .cu'));
		assert.ok(profileContext?.when?.includes('resourceExtname == .cuh'));
		assert.ok(isSupportedBenchmarkFile('/workspace/kernel.cu'));
		assert.ok(isSupportedBenchmarkFile('/workspace/kernel.cuh'));
		const diagnosticsSetting = manifest.contributes.configuration.properties['kernelpilot.nvidiaDiagnosticsEnabled'];
		assert.strictEqual(diagnosticsSetting.default, false, 'NVIDIA diagnostics must stay opt-in');
		assert.ok(manifest.contributes.commands.some(command => command.command === 'rogowskikernelpilot.nvidiaDiagnostics'));
		assert.ok(manifest.contributes.commands.some(command => command.command === 'rogowskikernelpilot.checkNvidiaDiagnosticsEnvironment' && command.title === 'KernelPilot: Check NVIDIA Diagnostics Environment'));
		assert.ok(manifest.contributes.commands.some(command => command.command === 'rogowskikernelpilot.validateCudaResults' && command.title === 'KernelPilot: Validate CUDA Results Against Reference'));
		assert.ok(manifest.contributes.commands.some(command => command.command === 'rogowskikernelpilot.compareOptimizationReports' && command.title === 'KernelPilot: Compare Optimization Reports'));
	});

	test('comparison command opens two reports, renders evidence and exports Markdown without changing inputs', async function () {
		this.timeout(10000);
		const root = await mkdtemp(path.join(os.tmpdir(), 'kernelpilot compare reports ')); const baselinePath = path.join(root, 'baseline report.json'), candidatePath = path.join(root, 'candidate report.json'), outputPath = path.join(root, 'comparison output.md');
		const makeReport = (factor: number) => ({ schema: 'kernelpilot-bottleneck-profile-v1', gpu: 'Test GPU', inputSha256: 'same', elementCounts: [32], timerScope: { cuda: 'same CUDA event kernel timer' }, compileArguments: ['nvcc', '-O3'], environment: { runtime: 'test' }, cudaResultValidation: { status: 'passed' }, rawPhaseSamples: [10, 10.1, 9.9, 10.2, 9.8, 10.05].map((value, sample) => ({ backend: 'CUDA', phase: 'kernel', size: 32, sample, milliseconds: value * factor })) });
		await writeFile(baselinePath, JSON.stringify(makeReport(1))); await writeFile(candidatePath, JSON.stringify(makeReport(0.7)));
		const baselineBefore = await readFile(baselinePath, 'utf8'), candidateBefore = await readFile(candidatePath, 'utf8');
		const window = vscode.window as unknown as { showOpenDialog: (...args: unknown[]) => Promise<vscode.Uri[] | undefined>; showSaveDialog: (...args: unknown[]) => Promise<vscode.Uri | undefined>; createWebviewPanel: typeof vscode.window.createWebviewPanel };
		const originals = { open: window.showOpenDialog.bind(vscode.window), save: window.showSaveDialog.bind(vscode.window), panel: window.createWebviewPanel.bind(vscode.window) };
		const picks = [baselinePath, candidatePath]; let html = ''; let receiver: ((message: unknown) => unknown) | undefined;
		window.showOpenDialog = async () => {const next = picks.shift(); return next ? [vscode.Uri.file(next)] : undefined;};
		window.showSaveDialog = async () => vscode.Uri.file(outputPath);
		window.createWebviewPanel = (() => {
			const webview = { html: '', onDidReceiveMessage: (handler: (message: unknown) => unknown) => {receiver = handler; return { dispose() {} };} };
			const panel = { webview, reveal() {}, dispose() {}, onDidDispose() {return { dispose() {} };} } as unknown as vscode.WebviewPanel;
			Object.defineProperty(webview, 'html', { get: () => html, set: (value: string) => {html = value;} }); return panel;
		}) as typeof vscode.window.createWebviewPanel;
		try {
			await vscode.commands.executeCommand('rogowskikernelpilot.compareOptimizationReports');
			assert.ok(html.includes('Optimization report comparison')); assert.ok(html.includes('95% interval')); assert.ok(html.includes('Correctness'));
			assert.ok(receiver); await receiver!({ type: 'export', format: 'markdown' });
			const markdown = await readFile(outputPath, 'utf8'); assert.ok(markdown.includes('# KernelPilot report comparison')); assert.ok(markdown.includes('Recommendation evidence'));
			assert.strictEqual(await readFile(baselinePath, 'utf8'), baselineBefore); assert.strictEqual(await readFile(candidatePath, 'utf8'), candidateBefore);
		} finally {window.showOpenDialog = originals.open; window.showSaveDialog = originals.save; window.createWebviewPanel = originals.panel; await rm(root, { recursive: true, force: true });}
	});

	test('environment check command invokes capability probes, writes a report and offers details/save actions', async function () {
		this.timeout(10000);
		const root = await mkdtemp(path.join(os.tmpdir(), 'kernelpilot env command '));
		const ncu = path.join(root, 'fake ncu'), sanitizer = path.join(root, 'fake sanitizer'), reportDirectory = path.join(root, 'reports');
		const tool = (version: string) => `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${version}'; elif [ "$1" = "--help" ]; then echo '--query-metrics --query-metrics-mode --csv'; elif [ "$1" = "--query-metrics" ]; then echo 'sm__throughput.avg.pct_of_peak_sustained_elapsed'; else exit 2; fi\n`;
		await writeFile(ncu, tool('Nsight Compute fake 1')); await writeFile(sanitizer, tool('Compute Sanitizer fake 1'));
		await Promise.all([ncu, sanitizer].map(file => chmod(file, 0o700)));
		const config = vscode.workspace.getConfiguration('kernelpilot');
		const keys = ['ncuPath', 'computeSanitizerPath', 'nvidiaDiagnosticsReportDirectory'] as const;
		const previous = Object.fromEntries(keys.map(key => [key, config.inspect(key)?.globalValue]));
		const windowApi = vscode.window as unknown as { createOutputChannel: (name: string, options?: { log: boolean }) => vscode.OutputChannel; showInformationMessage: (...args: unknown[]) => Promise<unknown> };
		const originalCreate = windowApi.createOutputChannel.bind(vscode.window); const originalInfo = windowApi.showInformationMessage.bind(vscode.window);
		const lines: string[] = [];
		windowApi.createOutputChannel = (name, options) => {const channel = originalCreate(name, options); const append = channel.appendLine.bind(channel); channel.appendLine = line => {lines.push(line); append(line);}; return channel;};
		windowApi.showInformationMessage = async () => undefined;
		try {
			await config.update('ncuPath', ncu, vscode.ConfigurationTarget.Global); await config.update('computeSanitizerPath', sanitizer, vscode.ConfigurationTarget.Global);
			await config.update('nvidiaDiagnosticsReportDirectory', reportDirectory, vscode.ConfigurationTarget.Global);
			await vscode.commands.executeCommand('rogowskikernelpilot.checkNvidiaDiagnosticsEnvironment');
			assert.ok(lines.some(line => line.includes('Nsight Compute fake 1')), lines.join('\n'));
			assert.ok(lines.some(line => line.includes('query-only-success-not-proof')));
			const reports = await readdir(reportDirectory);
			assert.strictEqual(reports.filter(name => name.endsWith('.json')).length, 1);
			const saved = JSON.parse(await readFile(path.join(reportDirectory, reports.find(name => name.endsWith('.json'))!), 'utf8')) as { counters: { status: string } };
			assert.strictEqual(saved.counters.status, 'query-only-success-not-proof');
		} finally {
			windowApi.createOutputChannel = originalCreate; windowApi.showInformationMessage = originalInfo;
			for (const key of keys) {await config.update(key, previous[key], vscode.ConfigurationTarget.Global);}
			await rm(root, { recursive: true, force: true });
		}
	});

	test('ready-executable diagnostics command passes spaced paths and JSON arguments and writes joined outputs', async function () {
		this.timeout(10000);
		const root = await mkdtemp(path.join(os.tmpdir(), 'kernelpilot ready executable '));
		const exe = path.join(root, 'target executable'), ncu = path.join(root, 'fake ncu'), sanitizer = path.join(root, 'fake sanitizer');
		const targetArgs = path.join(root, 'target args.json'), reportDirectory = path.join(root, 'reports');
		await writeFile(exe, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(targetArgs)},JSON.stringify(process.argv.slice(2)));\n`); await chmod(exe, 0o700);
		const metric = 'sm__throughput.avg.pct_of_peak_sustained_elapsed';
		const csv = `"ID","Process ID","Kernel Name","Metric Name","Metric Unit","Metric Value"\n"0","123","fakeKernel","${metric}","%","42"`;
		await writeFile(ncu, `#!/usr/bin/env node\nconst a=process.argv.slice(2); if(a.includes('--version')) console.log('ncu fake'); else if(a.includes('--query-metrics')) console.log(${JSON.stringify(metric)}); else if(a.includes('--metrics')) { console.log(${JSON.stringify(csv)}); require('node:fs').writeFileSync(a[a.indexOf('--export')+1],'fake report'); } else process.exit(2);\n`);
		await writeFile(sanitizer, `#!/usr/bin/env node\nconst a=process.argv.slice(2); if(a.includes('--version')) {console.log('sanitizer fake'); process.exit(0);} const i=a.indexOf('--'); const r=require('node:child_process').spawnSync(a[i+1],a.slice(i+2),{cwd:process.cwd(),encoding:'utf8'}); if(r.error) {console.error(r.error.message); process.exit(2);} process.stdout.write(r.stdout||''); console.log('========= ERROR SUMMARY: 0 errors'); process.exit(r.status||0);\n`);
		await Promise.all([ncu, sanitizer].map(file => chmod(file, 0o700)));
		const config = vscode.workspace.getConfiguration('kernelpilot');
		const keys = ['nvidiaDiagnosticsEnabled', 'ncuPath', 'computeSanitizerPath', 'nvidiaDiagnosticsReportDirectory', 'ncuLaunchCount', 'computeSanitizerTools'] as const;
		const previous = Object.fromEntries(keys.map(key => [key, config.inspect(key)?.globalValue]));
		const input = vscode.window as unknown as { showInputBox: (...args: unknown[]) => Promise<string | undefined>; showErrorMessage: (...args: unknown[]) => Promise<unknown> };
		const originalInput = input.showInputBox.bind(vscode.window); const originalError = input.showErrorMessage.bind(vscode.window); const prompts = [exe, JSON.stringify(['space value', '; touch /tmp/should-not-execute', 'quote"value']), 'fakeKernel'];
		let error = '';
		input.showInputBox = async () => prompts.shift(); input.showErrorMessage = async message => {error = String(message); return undefined;};
		try {
			await config.update('nvidiaDiagnosticsEnabled', true, vscode.ConfigurationTarget.Global); await config.update('ncuPath', ncu, vscode.ConfigurationTarget.Global);
			await config.update('computeSanitizerPath', sanitizer, vscode.ConfigurationTarget.Global); await config.update('nvidiaDiagnosticsReportDirectory', reportDirectory, vscode.ConfigurationTarget.Global);
			await config.update('computeSanitizerTools', ['memcheck'], vscode.ConfigurationTarget.Global);
			await vscode.commands.executeCommand('rogowskikernelpilot.nvidiaDiagnostics');
			assert.strictEqual(error, '');
			assert.deepStrictEqual(JSON.parse(await readFile(targetArgs, 'utf8')), ['space value', '; touch /tmp/should-not-execute', 'quote"value']);
			const reports = await readdir(reportDirectory);
			const json = reports.find(name => name.endsWith('.json')); assert.ok(json);
			const report = JSON.parse(await readFile(path.join(reportDirectory, json!), 'utf8')) as { args: string[]; profile: { status: string; metrics: Array<{ kernel: string; launchId: string; unit?: string }> }; sanitizers: Array<{ status: string }> };
			assert.deepStrictEqual(report.args, ['space value', '; touch /tmp/should-not-execute', 'quote"value']);
			assert.strictEqual(report.profile.status, 'completed'); assert.deepStrictEqual(report.profile.metrics[0], { kernel: 'fakeKernel', launchId: '0', name: metric, value: '42', unit: '%' });
			assert.strictEqual(report.sanitizers.find(item => item.status === 'clean')?.status, 'clean');
			assert.ok(reports.some(name => name.endsWith('.txt'))); assert.ok(reports.some(name => name.endsWith('.ncu-rep')));
		} finally {
			input.showInputBox = originalInput; input.showErrorMessage = originalError;
			for (const key of keys) {await config.update(key, previous[key], vscode.ConfigurationTarget.Global);}
			await rm(root, { recursive: true, force: true });
		}
	});

	test('CUDA result validation command runs isolated reference/candidate, attaches passing result and blocks a faulty optimization', async function () {
		this.timeout(30000);
		const root = await mkdtemp(path.join(os.tmpdir(), 'kernelpilot validation command '));
		const reference = path.join(root, 'reference program'), candidate = path.join(root, 'candidate program');
		const source = (candidateProgram: boolean) => `#!/usr/bin/env node\nconst fs=require('node:fs'); const args=process.argv.slice(2); const at=args.indexOf('--kernelpilot-input'); if(at<0) process.exit(4); const rows=fs.readFileSync(args[at+1],'utf8').split(/\\r?\\n/).filter(x=>x.startsWith('value,')); const bad=${candidateProgram} && args.includes('--buggy'); const vals=rows.map(x=>Number(x.split(',')[2])+1+(bad?0.5:0)); console.log('KP_RESULT_V1,float64,'+vals.length); vals.forEach((v,i)=>console.log('KP_VALUE,'+i+','+v));\n`;
		await writeFile(reference, source(false)); await writeFile(candidate, source(true)); await Promise.all([reference, candidate].map(file => chmod(file, 0o700)));
		const profilePath = path.join(root, 'existing-profile.json'); await writeFile(profilePath, JSON.stringify({ rawSamples: [{ milliseconds: 1 }], nvidiaDiagnostics: { status: 'separate' } }));
		const reportDirectory = path.join(root, 'validation reports'); const config = vscode.workspace.getConfiguration('kernelpilot');
		const keys = ['cudaResultValidationReportDirectory', 'cudaResultValidationInputCount', 'cudaResultValidationTimeoutMs', 'cudaResultValidationAbsoluteTolerance', 'cudaResultValidationRelativeTolerance'] as const;
		const previous = Object.fromEntries(keys.map(key => [key, config.inspect(key)?.globalValue]));
		const window = vscode.window as unknown as { showOpenDialog: (...args: unknown[]) => Promise<vscode.Uri[] | undefined>; showInputBox: (...args: unknown[]) => Promise<string | undefined>; showWarningMessage: (...args: unknown[]) => Promise<unknown>; showInformationMessage: (...args: unknown[]) => Promise<unknown>; createOutputChannel: (name: string, options?: { log: boolean }) => vscode.OutputChannel };
		const originals = { open: window.showOpenDialog.bind(vscode.window), input: window.showInputBox.bind(vscode.window), warning: window.showWarningMessage.bind(vscode.window), info: window.showInformationMessage.bind(vscode.window), channel: window.createOutputChannel.bind(vscode.window) };
		const lines: string[] = []; let selected: string[] = []; let infoCount = 0;
		window.showOpenDialog = async options => {
			const title = String((options as { title?: string })?.title ?? '');
			if (title.includes('existing KernelPilot CUDA report')) {return [vscode.Uri.file(profilePath)];}
			const next = selected.shift(); return next ? [vscode.Uri.file(next)] : undefined;
		};
		window.showInputBox = async options => {const title = String((options as { title?: string })?.title ?? ''); if (title === 'Reference program arguments') {return '[]';} if (title === 'CUDA candidate arguments') {return selected.shift() ?? '[]';} if (title === 'Validation seed') {return '77';} return undefined;};
		window.showWarningMessage = async () => 'Run isolated validation';
		window.showInformationMessage = async () => ++infoCount === 1 ? 'Attach to existing report' : undefined;
		window.createOutputChannel = (name, options) => {const channel = originals.channel(name, options); const append = channel.appendLine.bind(channel); channel.appendLine = line => {lines.push(line); append(line);}; return channel;};
		try {
			await config.update('cudaResultValidationReportDirectory', reportDirectory, vscode.ConfigurationTarget.Global); await config.update('cudaResultValidationInputCount', 3, vscode.ConfigurationTarget.Global);
			await config.update('cudaResultValidationTimeoutMs', 5000, vscode.ConfigurationTarget.Global); await config.update('cudaResultValidationAbsoluteTolerance', 0.001, vscode.ConfigurationTarget.Global);
			await config.update('cudaResultValidationRelativeTolerance', 0, vscode.ConfigurationTarget.Global);
			selected = [reference, candidate, '[]']; await vscode.commands.executeCommand('rogowskikernelpilot.validateCudaResults');
			const attached = JSON.parse(await readFile(profilePath, 'utf8')) as { rawSamples: unknown[]; nvidiaDiagnostics: { status: string }; cudaResultValidation: { status: string; seed: number }; optimizationGate: { status: string; recommendAsSpeedup: boolean } };
			assert.strictEqual(attached.rawSamples.length, 1); assert.strictEqual(attached.nvidiaDiagnostics.status, 'separate');
			assert.strictEqual(attached.cudaResultValidation.status, 'passed'); assert.strictEqual(attached.cudaResultValidation.seed, 77);
			assert.strictEqual(attached.optimizationGate.status, 'correctness-passed-performance-unverified'); assert.strictEqual(attached.optimizationGate.recommendAsSpeedup, false);
			selected = [reference, candidate, JSON.stringify(['--buggy', '; literal shell text'])]; await vscode.commands.executeCommand('rogowskikernelpilot.validateCudaResults');
			const reportPaths = lines.filter(line => line.startsWith('Validation report: ')).map(line => line.slice('Validation report: '.length));
			assert.strictEqual(reportPaths.length, 2); const failed = JSON.parse(await readFile(reportPaths[1], 'utf8')) as { status: string; comparison: { mismatchCount: number }; optimizationAssessment: { disposition: string; recommendAsSpeedup: boolean } };
			assert.strictEqual(failed.status, 'failed'); assert.strictEqual(failed.comparison.mismatchCount, 3);
			assert.strictEqual(failed.optimizationAssessment.disposition, 'incorrect'); assert.strictEqual(failed.optimizationAssessment.recommendAsSpeedup, false);
			assert.ok(lines.some(line => line.includes('Correctness validation: passed'))); assert.ok(lines.some(line => line.includes('Correctness validation: failed')));
		} finally {
			window.showOpenDialog = originals.open; window.showInputBox = originals.input; window.showWarningMessage = originals.warning; window.showInformationMessage = originals.info; window.createOutputChannel = originals.channel;
			for (const key of keys) {await config.update(key, previous[key], vscode.ConfigurationTarget.Global);}
			await rm(root, { recursive: true, force: true });
		}
	});

	test('disabled NVIDIA command exits before invoking configured tools', async function () {
		this.timeout(5000);
		const root = await mkdtemp(path.join(os.tmpdir(), 'kernelpilot-disabled-nvidia-'));
		const marker = path.join(root, 'tool-ran'); const fakeNcu = path.join(root, 'fake ncu');
		await writeFile(fakeNcu, `#!/bin/sh\ntouch '${marker}'\n`, 'utf8'); await chmod(fakeNcu, 0o700);
		const config = vscode.workspace.getConfiguration('kernelpilot');
		const keys = ['nvidiaDiagnosticsEnabled', 'ncuPath'] as const;
		const previous = Object.fromEntries(keys.map(key => [key, config.inspect(key)?.globalValue]));
		const window = vscode.window as unknown as { showWarningMessage: (...args: unknown[]) => Promise<unknown> };
		const originalWarning = window.showWarningMessage.bind(vscode.window); let disabledNotice = false;
		window.showWarningMessage = async (...args) => {disabledNotice ||= String(args[0] ?? '').includes('diagnostics are disabled'); return undefined;};
		try {
			await config.update('nvidiaDiagnosticsEnabled', false, vscode.ConfigurationTarget.Global);
			await config.update('ncuPath', fakeNcu, vscode.ConfigurationTarget.Global);
			await vscode.commands.executeCommand('rogowskikernelpilot.nvidiaDiagnostics');
			assert.ok(disabledNotice);
			await assert.rejects(access(marker), { code: 'ENOENT' });
		} finally {
			window.showWarningMessage = originalWarning;
			for (const key of keys) {await config.update(key, previous[key], vscode.ConfigurationTarget.Global);}
			await rm(root, { recursive: true, force: true });
		}
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
