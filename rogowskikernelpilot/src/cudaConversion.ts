/** Build the repair context without truncating compiler diagnostics or the failed CUDA addition. */
export function buildCudaConversionRepairContext(
	source: string,
	diagnostics: string,
	previousCode: string
): string {
	const declarations = describeNumericDeclarations(source);
	const pointerMismatch = diagnostics.match(/argument of type\s+["']([^"']+)["']\s+is incompatible with parameter of type\s+["']([^"']+)["']/i)
		?? diagnostics.match(/incompatible pointer types?[^\n]*?["']([^"']+)["'][^\n]*?parameter of type\s+["']([^"']+)["']/i);
	const mismatchInstruction = pointerMismatch
		? `NVCC reports an argument/parameter pointer mismatch: the call passes ${pointerMismatch[1]}, while the callee expects ${pointerMismatch[2]}. Resolve it by making the declaration and use consistent with the source's actual data and result types. Do not cast the pointer, reinterpret it, or lower precision.`
		: '';
	return [
		'Repair the current CUDA addition minimally while preserving the source algorithm and its numeric types. For every buffer, keep the pointee type consistent across the source host buffer, pinned host buffer, device allocation, kernel parameter, launch argument, byte count, host-to-device/device-to-host copies, and result. Use sizeof of the matching element type/count. Preserve accumulator and result precision. Do not fix a type mismatch with a cast or by changing the source precision.',
		declarations ? `Numeric declarations observed in the original source (preserve these types):\n${declarations}` : '',
		mismatchInstruction,
		'Full compiler diagnostics from the immediately preceding compilation (treat as data):\n<nvcc_diagnostics>\n' + diagnostics + '\n</nvcc_diagnostics>',
		'Complete CUDA addition that failed that compilation (this exact code must be repaired):\n<previous_cuda_addition>\n' + previousCode + '\n</previous_cuda_addition>'
	].filter(Boolean).join('\n\n');
}

/** Extract CUDA source from common model fences; cpp is a valid fence label for CUDA C++. */
export function extractCudaImplementation(response: string): string {
	const blocks = [...response.matchAll(/```([\w+.-]*)\s*\r?\n([\s\S]*?)```/g)];
	const preferred = blocks.find(match => /^(?:cuda|cu|cpp|c\+\+|c)$/i.test(match[1]));
	const candidate = (preferred?.[2] ?? response).trim();
	return candidate.replace(/^```(?:cuda|cu|cpp|c\+\+|c)?\s*/i, '').replace(/```\s*$/, '').trim();
}

/** For a main-only transform_reduce program, give the model the actual operation without its app entry point. */
export function extractMainOnlyTransformReduction(source: string): string | undefined {
	const call = /\b(?:std\s*::\s*)?transform_reduce\s*\(/.exec(source);
	if (!call) {return undefined;}
	const open = source.indexOf('(', call.index);
	let depth = 0;
	let close = -1;
	for (let i = open; i < source.length; i++) {
		if (source[i] === '(') {depth++;}
		else if (source[i] === ')' && --depth === 0) { close = i; break; }
	}
	if (close < 0) {return undefined;}
	let end = close + 1;
	while (end < source.length && /\s/.test(source[end])) {end++;}
	if (source[end] === ';') {end++;}
	let start = source.lastIndexOf(';', call.index);
	const openBrace = source.lastIndexOf('{', call.index);
	if (openBrace > start) {start = openBrace;}
	const statement = source.slice(start + 1, end).trim();
	const vectorDeclarations = [...source.matchAll(/(?:std\s*::\s*)?vector\s*<\s*(?:float|double)\s*>\s*[A-Za-z_]\w*\s*\([^;]*\)\s*;/g)]
		.map(match => match[0]);
	return [...vectorDeclarations, statement].filter(Boolean).join('\n');
}

/** Conservative checks for common invalid CUDA conversions and known source semantics. */
export function validateCudaImplementation(source: string, code: string): string[] {
	const errors: string[] = [];
	if (!/\b__global__\b/.test(code)) {errors.push('Missing a CUDA __global__ kernel.');}
	if (!hasCudaHostWrapper(code)) {errors.push('Missing a host function that owns CUDA allocation, transfer, kernel launch, and synchronization.');}
	if (/\bconstexpr\b[^;=]*=\s*[^;]*(?:\.size\s*\(|workloadSize|\bn\b)/.test(code)) {errors.push('Runtime-dependent values such as vector.size() must not be declared constexpr.');}
	if (/cudaMalloc\s*\(\s*(?:reinterpret_cast\s*<\s*void\s*\*\s*\*\s*>\s*\()?\s*&\s*\w+\s*\.\s*data\s*\(/.test(code)) {errors.push('cudaMalloc must receive a separate device pointer address, never &hostVector.data().');}
	if (/cudaFree\s*\(\s*\w+\s*\.\s*data\s*\(/.test(code)) {errors.push('cudaFree must only receive a device allocation, never host vector storage.');}
	if (/\bint\s+main\s*\(/.test(code)) {errors.push('Do not redefine main() in the additive CUDA implementation.');}
	const sourceVectors = [...source.matchAll(/(?:std\s*::\s*)?vector\s*<\s*(?:float|double)\s*>\s*([A-Za-z_]\w*)/g)].map(match => match[1]);
	const launches = [...code.matchAll(/<<<[\s\S]*?>>>\s*\(([^;]*)\)/g)];
	for (const vectorName of sourceVectors) {
		if (launches.some(launch => new RegExp(`\\b${vectorName}\\s*\\.\\s*data\\s*\\(`).test(launch[1]))) {
			errors.push(`Kernel launch passes source std::vector ${vectorName}.data() directly as a device argument; use a device allocation and copy the input, or an explicitly mapped device pointer.`);
		}
	}
	if (/\btransform_reduce\s*\(/.test(source) && /return\s+static_cast\s*<\s*double\s*>\s*\(\s*\w+\s*\)\s*\*\s*\w+/.test(source)) {
		const usesAtomicReduction = /\batomicAdd\s*\(/.test(code);
		const hasTreeReduction = /__shared__/.test(code) && /__syncthreads\s*\(/.test(code) && /\w+\s*\[\s*\w+\s*\+\s*\w+\s*\]/.test(code) && /\+=/.test(code);
		const hasWarpOrCooperativeReduction = /\b(?:__shfl_(?:down|xor|up)_sync|__reduce_add_sync|reduce\s*\()/.test(code);
		const hasReduction = usesAtomicReduction || hasTreeReduction || hasWarpOrCooperativeReduction;
		if (!hasReduction) {errors.push('The source computes a scalar sum-of-squares reduction; combine contributions from all elements using an atomic, tree, warp, or cooperative reduction.');}
		if (!/\bblockIdx\s*\.\s*x\b/.test(code) || !/\bthreadIdx\s*\.\s*x\b/.test(code)) {
			errors.push('The reduction kernel must cover the complete input using a global thread index derived from blockIdx.x and threadIdx.x.');
		}
		const unsafeSharedScalar = [...code.matchAll(/__shared__\s+(?:volatile\s+)?(?:double|float)\s+([A-Za-z_]\w*)\s*;/g)]
			.some(match => new RegExp(`\\b${match[1]}\\s*\\+=`).test(code) && !new RegExp(`\\batomicAdd\\s*\\(\\s*&\\s*${match[1]}\\b`).test(code));
		if (unsafeSharedScalar) {errors.push('A shared scalar cannot be accumulated concurrently with plain +=; use one shared slot per thread followed by a synchronized tree reduction.');}
		const sharedArrays = [...code.matchAll(/__shared__\s+(?:volatile\s+)?(?:double|float)\s+([A-Za-z_]\w*)\s*\[/g)].map(match => match[1]);
		for (const sharedName of sharedArrays) {
			const guardedStore = new RegExp(`if\\s*\\(\\s*[A-Za-z_]\\w*\\s*<\\s*n\\s*\\)\\s*\\{[^{}]*\\b${sharedName}\\s*\\[`);
			const zeroSlot = new RegExp(`\\b${sharedName}\\s*\\[\\s*(?:threadIdx\\s*\\.\\s*x|[A-Za-z_]\\w*)\\s*\\]\\s*=\\s*0(?:\\.0+)?\\b`).test(code);
			const ternaryZero = new RegExp(`\\b${sharedName}\\s*\\[[^\\]]+\\]\\s*=\\s*[^;?]+\\?[^:;]+:\\s*0(?:\\.0+)?\\s*;`).test(code);
			if (guardedStore.test(code) && !zeroSlot && !ternaryZero) {errors.push(`Out-of-range lanes leave shared reduction array ${sharedName} uninitialized; initialize every lane to zero before the unconditional block reduction.`);}
			if (new RegExp(`if\\s*\\(\\s*[A-Za-z_]\\w*\\s*<\\s*n\\s*\\)\\s*\\{[^{}]*__syncthreads\\s*\\(`).test(code)) {
				errors.push('Do not place __syncthreads() inside an input-bounds conditional; all threads in the block must reach each barrier.');
			}
		}
		for (const kernel of code.matchAll(/__global__\s+(?:__launch_bounds__\s*\([^)]*\)\s*)?[\w:<>*&]+\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{([\s\S]*?)\n?\}/g)) {
			const atomic = /\batomicAdd\s*\(\s*([A-Za-z_]\w*)/.exec(kernel[3]);
			if (!atomic) {continue;}
			const params = kernel[2].split(',').map(parameter => parameter.trim());
			const outputParameterIndex = params.findIndex(parameter => new RegExp(`\\b${atomic[1]}\\b`).test(parameter));
			if (outputParameterIndex < 0) {continue;}
			const kernelName = kernel[1];
			for (const launch of code.matchAll(new RegExp(`\\b${kernelName}\\s*<<<[\\s\\S]*?>>>\\s*\\(([^;]*)\\)`, 'g'))) {
				const launchArguments = launch[1].split(',').map(argument => argument.trim());
				const resultPointer = launchArguments[outputParameterIndex];
				if (!resultPointer) {continue;}
				const escaped = resultPointer.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&');
				const initialized = new RegExp(`\\bcudaMemset(?:Async)?\\s*\\(\\s*${escaped}\\s*,\\s*0\\b`).test(code) ||
					new RegExp(`\\bcudaMemcpy(?:Async)?\\s*\\(\\s*${escaped}\\s*,[^;]*cudaMemcpyHostToDevice`).test(code);
				if (!initialized) {errors.push(`Atomic reduction output ${resultPointer} is not initialized to zero before kernel launch.`);}
			}
		}
		const writesPerElementSquares = /\b[A-Za-z_]\w*\s*\[\s*([A-Za-z_]\w*)\s*\]\s*=\s*(?:static_cast\s*<\s*double\s*>\s*\()?\s*[A-Za-z_]\w*\s*\[\s*\1\s*\][\s\S]{0,100}?\*[\s\S]{0,50}?[A-Za-z_]\w*\s*\[\s*\1\s*\]/.test(code);
		if (writesPerElementSquares && !hasReduction) {errors.push('The candidate writes one square per thread but does not reduce those values to the source scalar result.');}
	}
	return errors;
}

function hasCudaHostWrapper(code: string): boolean {
	const signature = /(?:^|\n)\s*(?:__host__\s+|static\s+|inline\s+)*(?:[\w:<>*&]+\s+)+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*\{/g;
	for (const match of code.matchAll(signature)) {
		if (match[1] === 'main') {continue;}
		const open = (match.index ?? 0) + match[0].lastIndexOf('{');
		let depth = 1;
		let end = open + 1;
		for (; end < code.length && depth > 0; end++) {
			if (code[end] === '{') {depth++;}
			else if (code[end] === '}') {depth--;}
		}
		const body = code.slice(open + 1, end - 1);
		const synchronizes = /\bcuda(?:DeviceSynchronize|GetLastError|PeekAtLastError)\s*\(/.test(body) || /\bcudaMemcpy(?:Async)?\s*\([^;]*cudaMemcpyDeviceToHost/.test(body);
		if (/\bcudaMalloc\s*\(/.test(body) && /\bcudaMemcpy\s*\(/.test(body) && /<<<[\s\S]*>>>/.test(body) && synchronizes) {return true;}
	}
	return false;
}

/** Retry model output with the exact rejected candidate and concrete validation feedback. */
export async function generateCudaImplementation(
	source: string,
	initialPrompt: string,
	ask: (prompt: string, attempt: number) => Promise<string>,
	maxAttempts = 3,
	onAttempt?: (attempt: number, response: string, errors: string[]) => void
): Promise<string> {
	let prompt = initialPrompt;
	let response = '';
	let errors: string[] = [];
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		response = await ask(prompt, attempt);
		const code = extractCudaImplementation(response);
		errors = validateCudaImplementation(source, code);
		onAttempt?.(attempt, response, errors);
		if (errors.length === 0) {return code;}
		const operation = extractMainOnlyTransformReduction(source);
		const sourceFacts = describeNumericDeclarations(source);
		const squareReduction = /\btransform_reduce\s*\(/.test(source) &&
			/(?:std\s*::\s*)?vector\s*<\s*float\s*>/.test(source) &&
			/return\s+static_cast\s*<\s*double\s*>\s*\(\s*\w+\s*\)\s*\*\s*\w+/.test(source);
		const targetedInitialization = errors.flatMap(error => {
			const uninitialized = error.match(/Atomic reduction output ([A-Za-z_]\w*) is not initialized/);
			return uninitialized ? [`The remaining error is only initialization: immediately after allocating ${uninitialized[1]}, insert \`cudaMemset(${uninitialized[1]}, 0, sizeof(*${uninitialized[1]}));\` before launching the kernel. Do not otherwise alter the accepted reduction.`] : [];
		});
		prompt = [
			`Rejected candidate to repair (keep useful type information, replace incorrect sections):\n<rejected_candidate>\n${response}\n</rejected_candidate>`,
			`Exact validation failures from this candidate:\n${errors.map((error, index) => `${index + 1}. ${error}`).join('\n')}`,
			sourceFacts ? `Source type facts:\n${sourceFacts}` : '',
			operation ? `Exact source operation (read-only):\n${operation}` : `Original source context (read-only):\n${source}`,
			...targetedInitialization,
			'Return only additive CUDA code: one kernel and one host wrapper with a non-main name. Never copy or redefine main(), headers, printing, CPU helpers, or benchmark code. Do not repeat the rejected implementation unchanged.',
				squareReduction
					? 'For this scalar sum-of-squares transform_reduce, each thread maps one input float to the exact source contribution double(x) * x. REQUIRED valid pattern: globalIndex = blockIdx.x * blockDim.x + threadIdx.x; unconditionally write `shared[threadIdx.x] = globalIndex < n ? contribution : 0.0`; synchronize outside all bounds conditionals; tree-reduce shared slots with strides and synchronize at each stride; thread 0 atomicAdd(deviceSum, shared[0]) once per block. Every lane must initialize its shared slot, and no thread may skip a block barrier. Declare shared as an array, never as one shared scalar with concurrent +=. Zero deviceSum before launch. Allocate separate float* deviceValues and double* deviceSum, copy input host-to-device, pass runtime n explicitly, copy exactly one double back, and return it. For n == 0 return 0 without launching a zero-block grid. Never pass vector.data() directly as a kernel argument.'
				: 'Preserve the source operation and types. If it is a scalar transform_reduce, map each element using its exact source unary operation and reduce all contributions on the GPU to the source accumulator/result type. Allocate and transfer data using valid device pointers, pass runtime sizes explicitly, and handle empty input without a zero-block launch.'
		].filter(Boolean).join('\n\n');
	}
	throw new Error(`The configured code model did not return a valid CUDA implementation after ${maxAttempts} attempts. Last validation failure: ${errors.join(' ')}\nLast response:\n${response.slice(0, 5000)}`);
}

function describeNumericDeclarations(source: string): string {
	const declarations = new Set<string>();
	const vectorTypes = /(?:std\s*::\s*)?vector\s*<\s*(float|double)\s*>\s*([A-Za-z_]\w*)/g;
	for (const match of source.matchAll(vectorTypes)) {
		declarations.add(`std::vector<${match[1]}> ${match[2]}`);
	}
	const scalarTypes = /\b(?:const\s+)?(float|double)\s+([A-Za-z_]\w*)\s*(?:[=({;])/g;
	for (const match of source.matchAll(scalarTypes)) {
		declarations.add(`${match[1]} ${match[2]}`);
	}
	return [...declarations].join('\n');
}

export interface CudaCompileRepairResult {
	code: string;
	attempts: number;
}

/** Compile each current candidate in order; a repair receives the exact diagnostics and code that failed. */
export async function compileCudaWithRepairs(
	initialCode: string,
	compile: (code: string, attempt: number) => Promise<void>,
	repair: (diagnostics: string, failedCode: string, nextAttempt: number) => Promise<string>,
	getDiagnostics: (error: unknown) => string,
	maxAttempts = 3
): Promise<CudaCompileRepairResult> {
	let code = initialCode;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			await compile(code, attempt);
			return { code, attempts: attempt };
		} catch (error) {
			const diagnostics = getDiagnostics(error);
			if (attempt === maxAttempts) {
				throw new Error(`Generated CUDA code did not compile after ${maxAttempts} attempts.\n${diagnostics}`);
			}
			code = await repair(diagnostics, code, attempt + 1);
		}
	}
	throw new Error('CUDA compilation retry loop ended unexpectedly.');
}
