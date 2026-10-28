import { detectFixedWorkloadElementCount } from './benchmarkWorkload';

/** AST facts used to select and verify a benchmark target. */
export interface BenchmarkFunctionFacts {
	name: string;
	returnType: string;
	parameters: Array<{ name: string; type: string }>;
	line: number;
	loops: Array<{ type: string; line: number; reads: string[]; writes: string[]; indexedReads: string[]; indexedWrites: string[] }>;
	conditions: Array<{ type: string; line: number }>;
	calls: Array<{ name: string; line: number; insideLoop: boolean }>;
}

export interface BenchmarkAnalysisFacts { file: string; functions: BenchmarkFunctionFacts[] }

/** Clang's exact diagnostic when a runtime parameter initializes constexpr. */
export function isRuntimeDependentConstexprDiagnostic(diagnostics: string): boolean {
	return /\bconstexpr\s+(?:variable|variable template)\b[\s\S]{0,240}\bmust be initialized by a constant expression\b/i.test(diagnostics) ||
		/\b(?:not a constant expression|is not a constant expression|non-constant expression)\b/i.test(diagnostics);
}

export type BenchmarkTarget =
	| { kind: 'function'; functionName: string; candidates: BenchmarkFunctionFacts[] }
	| { kind: 'main'; functionName: 'main'; candidates: [] }
	| { kind: 'unsupported'; reason: string; candidates: BenchmarkFunctionFacts[] };

/** Extra input bounds for source algorithms whose element type makes overflow easy. */
export function benchmarkTargetInputGuidance(target: BenchmarkTarget): string {
	if (target.kind === 'function' && target.functionName === 'matrixMultiplicationCPU') {
		return 'For matrixMultiplicationCPU, use square n×n matrices with n = workloadSize and allocate n*n live int elements for each input. Fill row-major A[r*n+k] with (7*r+3*k+1)%2 and B[k*n+c] with (5*k+c+1)%3 exactly; A elements are 0/1 and B elements are 0/1/2. These inputs keep every dot product at most 512 for the largest n=256 and make B non-symmetric under transpose. Make exactly one live matrixMultiplicationCPU call and return the exact sum of all elements in its returned std::vector<int> as double; do not return zero, a constant, a partial checksum, or a checksum of the inputs.';
	}
	return '';
}

function score(fn: BenchmarkFunctionFacts): number {
	return fn.loops.length * 10 + fn.loops.reduce((value, loop) =>
		value + loop.indexedWrites.length * 4 + loop.indexedReads.length * 2 + loop.writes.length, 0) +
		fn.calls.filter(call => call.insideLoop).length;
}

/** Follow source-defined call edges from main and select the strongest computational callee. */
export function classifyBenchmarkTarget(analysis: BenchmarkAnalysisFacts): BenchmarkTarget {
	const main = analysis.functions.find(fn => fn.name === 'main');
	const definitions = analysis.functions.filter(fn => fn.name !== 'main' && !fn.name.startsWith('operator'));
	const byName = new Map<string, BenchmarkFunctionFacts[]>();
	for (const fn of definitions) {byName.set(fn.name, [...(byName.get(fn.name) ?? []), fn]);}
	const reachable = new Set<string>();
	const pending = [...(main?.calls.map(call => call.name) ?? [])];
	while (pending.length) {
		const name = pending.pop()!;
		if (reachable.has(name)) {continue;}
		reachable.add(name);
		for (const fn of byName.get(name) ?? []) {pending.push(...fn.calls.map(call => call.name));}
	}
	let candidates = definitions.filter(fn => reachable.has(fn.name));
	if (!candidates.length && !main) {candidates = definitions.filter(fn => fn.loops.length > 0);}
	if (candidates.length) {
		const ranked = candidates.map(fn => ({ fn, score: score(fn) })).sort((a, b) => b.score - a.score);
		if (ranked[0].score <= 0) {return { kind: 'unsupported', reason: 'AST found source functions reachable from main, but none contains a measurable computation (loop or indexed data operation).', candidates };}
		const top = ranked.filter(item => item.score === ranked[0].score);
		if (top.length !== 1) {return { kind: 'unsupported', reason: `AST found multiple equally plausible computational targets: ${top.map(item => item.fn.name).join(', ')}.`, candidates: top.map(item => item.fn) };}
		// A directly-called helper is often just setup. Prefer the deepest/highest
		// scoring reachable computation, not the first function in AST traversal.
		return { kind: 'function', functionName: top[0].fn.name, candidates };
	}
	if (main && main.calls.some(call => /^(?:transform_reduce|reduce|accumulate|inner_product|transform|sort|partial_sum|inclusive_scan|exclusive_scan|gemm|matmul|multiply)$/i.test(call.name))) {
		return { kind: 'main', functionName: 'main', candidates: [] };
	}
	return { kind: 'unsupported', reason: main
		? 'AST found code in main(), but no source-defined computation or supported algorithm call that can be safely anchored in a generated adapter. Refusing to guess an extraction.'
		: 'AST did not find main() or an unambiguous computational function to benchmark.', candidates };
}

function normalizedLambdaBodies(code: string): string[] {
	const bodies: string[] = [];
	const lambdaStart = /\[[^\]\n]*\]\s*(?:\([^)]*\))?/g;
	let match: RegExpExecArray | null;
	while ((match = lambdaStart.exec(code)) !== null) {
		let open = code.indexOf('{', match.index + match[0].length);
		const boundary = code.slice(match.index + match[0].length, open < 0 ? undefined : open);
		if (open < 0 || boundary.length > 120 || /[;{}]/.test(boundary)) {continue;}
		let depth = 1;
		let quote = '';
		let escaped = false;
		let close = open + 1;
		for (; close < code.length && depth > 0; close++) {
			const char = code[close];
			if (quote) {
				if (escaped) {escaped = false;}
				else if (char === '\\') {escaped = true;}
				else if (char === quote) {quote = '';}
				continue;
			}
			if (char === '"' || char === "'") { quote = char; continue; }
			if (char === '{') {depth++;}
			else if (char === '}') {depth--;}
		}
		if (depth === 0) {bodies.push(code.slice(open + 1, close - 1).replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, '').replace(/\s+/g, ''));}
		lambdaStart.lastIndex = Math.max(lambdaStart.lastIndex, close);
	}
	return bodies;
}

/** Require an AST call in the adapter body; comments, strings, and dead text do not count. */
export function validateBenchmarkAdapterFacts(
	adapterAnalysis: BenchmarkAnalysisFacts,
	target: BenchmarkTarget,
	originalAnalysis: BenchmarkAnalysisFacts,
	originalSource = '',
	adapterSource = ''
): string | undefined {
	const adapters = adapterAnalysis.functions.filter(fn => fn.name === 'kernelpilotRunTarget');
	if (adapters.length !== 1) {return `Expected exactly one kernelpilotRunTarget definition in generated adapter; found ${adapters.length}.`;}
	const generatedMains = adapterAnalysis.functions.filter(fn => fn.name === 'main').length;
	if (adapterAnalysis.functions.length > 1 && generatedMains !== 1) {return `Expected exactly one timing-driver main() definition; found ${generatedMains}.`;}
	for (const original of originalAnalysis.functions.filter(fn => fn.name !== 'main' && !fn.name.startsWith('operator'))) {
		const originalCount = originalAnalysis.functions.filter(fn => fn.name === original.name).length;
		const generatedCount = adapterAnalysis.functions.filter(fn => fn.name === original.name).length;
		if (generatedCount > originalCount) {return `Generated adapter duplicates source function ${original.name}().`;}
	}
	const adapter = adapters[0];
	if (adapter.parameters.length !== 1) {return 'kernelpilotRunTarget must accept exactly one workload-size parameter.';}
	if (adapter.loops.length === 0 && adapter.calls.length === 0) {return 'kernelpilotRunTarget contains no AST-visible computation or call.';}
	if (target.kind === 'function') {
		if (!adapter.calls.some(call => call.name === target.functionName)) {return `kernelpilotRunTarget does not make an AST-visible call to source function ${target.functionName}().`;}
		const sourceCount = detectFixedWorkloadElementCount(originalSource);
		const sourceTarget = originalAnalysis.functions.find(fn => fn.name === target.functionName);
		const vectorParameter = sourceTarget?.parameters.find(parameter => /(?:std\s*::\s*)?vector\s*</.test(parameter.type));
		if (sourceCount && vectorParameter && !adapterPassesExactVectorWorkload(adapterSource, originalSource, target.functionName, vectorParameter)) {
			return `The source declares a fixed ${sourceCount}-element workload, but the adapter does not visibly construct a vector sized from workloadSize, preserve the source initializer, and pass that vector to ${target.functionName}(). Actual source-workload mapping is unconfirmed.`;
		}
		return undefined;
	}
	if (target.kind === 'unsupported') {return target.reason;}
	const originalMain = originalAnalysis.functions.find(fn => fn.name === 'main');
	if (!originalMain) {return 'The original main() body is unavailable for validating a main-only extraction.';}
	const operations = originalMain.calls.map(call => call.name).filter(name =>
		/^(?:transform_reduce|reduce|accumulate|inner_product|transform|sort|partial_sum|inclusive_scan|exclusive_scan|gemm|matmul|multiply)$/i.test(name));
	if (!operations.length) {return 'The main-only algorithm has no recognized AST operation that can anchor an equivalent adapter.';}
	if (!operations.some(operation => adapter.calls.some(call => call.name === operation))) {
		return `Main-only adapter does not invoke the source algorithm operation(s): ${operations.join(', ')}.`;
	}
	const sourceLambdas = normalizedLambdaBodies(originalSource);
	if (sourceLambdas.some(body => body.length > 0) &&
		!sourceLambdas.every(body => normalizedLambdaBodies(adapterSource).includes(body))) {
		return 'Main-only adapter changed or omitted a source lambda body. Preserve the original lambda expression exactly; KernelPilot cannot otherwise establish equivalent operation semantics.';
	}
	const executionPolicy = originalSource.match(/\b(?:std\s*::\s*)?execution\s*::\s*(seq|par|par_unseq|unseq)\b/)?.[1];
	if (executionPolicy && !new RegExp(`\\b(?:std\\s*::\\s*)?execution\\s*::\\s*${executionPolicy}\\b`).test(adapterSource)) {
		return `Main-only adapter changed or omitted the original std::execution::${executionPolicy} policy.`;
	}
	return undefined;
}

function adapterPassesExactVectorWorkload(source: string, originalSource: string, functionName: string, parameter: { name: string; type: string }): boolean {
	const signature = /\bdouble\s+kernelpilotRunTarget\s*\([^)]*\)\s*\{/.exec(source);
	if (!signature) {return false;}
	const open = source.indexOf('{', signature.index);
	let depth = 1; let end = open + 1;
	for (; end < source.length && depth; end++) {
		if (source[end] === '{') {depth++;}
		else if (source[end] === '}') {depth--;}
	}
	const body = source.slice(open + 1, end - 1);
	const escapedFunction = escapeRegex(functionName);
	const call = new RegExp(`\\b${escapedFunction}\\s*\\(\\s*([A-Za-z_]\\w*)\\s*\\)`).exec(body);
	if (!call) {return false;}
	const argument = escapeRegex(call[1]);
	const type = escapeRegex(parameter.type.replace(/\bconst\b|\bvolatile\b|[&*]/g, '').trim());
	const allocated = new RegExp(`\\b${type}\\s+${argument}\\s*\\(\\s*workloadSize\\s*\\)`).test(body) ||
		new RegExp(`\\b${type}\\s+${argument}\\s*;[\\s\\S]*?\\b${argument}\\s*\\.\\s*resize\\s*\\(\\s*workloadSize\\s*\\)`).test(body);
	if (!allocated) {return false;}
	const initializer = new RegExp(`\\b${parameter.name}\\s*\\[\\s*([A-Za-z_]\\w*)\\s*\\]\\s*=\\s*([^;]+);`).exec(originalSource);
	if (!initializer) {return true;}
	const [, sourceIndex, expression] = initializer;
	const normalizedExpression = expression.replace(/\s+/g, '');
	const normalizedBody = body.replace(/\s+/g, '');
	return new RegExp(`${argument}\\[${sourceIndex}\\]=${escapeRegex(normalizedExpression)}`).test(normalizedBody);
}

export function sourceVectorInitializer(source: string, parameterName: string): { index: string; expression: string } | undefined {
	const match = new RegExp(`\\b${escapeRegex(parameterName)}\\s*\\[\\s*([A-Za-z_]\\w*)\\s*\\]\\s*=\\s*([^;]+);`).exec(source);
	return match ? { index: match[1], expression: match[2].trim() } : undefined;
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
