/** Workload sizes for main-only reductions over a source-declared fixed vector. */
export function isSupportedBenchmarkFile(filePath: string): boolean {
    return /\.(c|cc|cpp|cxx|h|hh|hpp|hxx|cu|cuh)$/i.test(filePath);
}

export function detectFixedReductionElementCount(source: string): number | undefined {
    if (!/(?:std\s*::\s*)?transform_reduce\s*\(/.test(source)) {return undefined;}
    const declaration = source.match(/(?:constexpr|const)\s+(?:std\s*::\s*)?size_t\s+\w+\s*=\s*([^;]+);/);
    if (!declaration) {return undefined;}
    const expression = declaration[1].replace(/[()\s]/g, '');
    const shift = expression.match(/^1(?:u|ul|ull|l|ll)?<<(\d+)$/i);
    if (shift) {
        const count = 2 ** Number(shift[1]);
        return Number.isSafeInteger(count) && count >= 4 && count % 4 === 0 && count <= 1_000_000_000 ? count : undefined;
    }
    const integer = expression.match(/^\d+(?:u|ul|ull|l|ll)?$/i);
    if (integer) {
        const count = Number.parseInt(expression, 10);
        return Number.isSafeInteger(count) && count >= 4 && count % 4 === 0 && count <= 1_000_000_000 ? count : undefined;
    }
    return undefined;
}

/** Detect a source-declared element count only when a size constant is used to create/fill an input. */
export function detectFixedWorkloadElementCount(source: string): number | undefined {
	const direct = detectFixedReductionElementCount(source);
	if (direct) {return direct;}
	const declaration = source.match(/(?:constexpr|const)\s+(?:std\s*::\s*)?size_t\s+([A-Za-z_]\w*)\s*=\s*([^;]+);/);
	if (!declaration) {return undefined;}
	const [, name, expression] = declaration;
	const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	if (!new RegExp(`(?:vector\\s*<[^>]+>\\s*\\w+\\s*\\(\\s*${escapedName}\\s*\\)|${escapedName}\\s*\\))`).test(source)) {return undefined;}
	const normalized = expression.replace(/[()\s]/g, '');
	const shift = normalized.match(/^1(?:u|ul|ull|l|ll)?<<(\d+)$/i);
	const literal = normalized.match(/^(\d+)(?:u|ul|ull|l|ll)?$/i);
	const value = shift ? 2 ** Number(shift[1]) : literal ? Number(literal[1]) : 0;
	return Number.isSafeInteger(value) && value > 0 && value <= 1_000_000_000 ? value : undefined;
}

/** Source-level repetition count is metadata; each harness sample still times one adapter call. */
export function detectSourceAlgorithmRepetitions(source: string): number | undefined {
	const declaration = source.match(/(?:constexpr|const)\s+(?:int|unsigned|std\s*::\s*size_t|size_t)\s+([A-Za-z_]\w*)\s*=\s*(\d+)\s*;/);
	if (!declaration) {return undefined;}
	const [, name, countText] = declaration;
	const loop = new RegExp(`for\\s*\\([^;]*;[^;]*<\\s*${name}\\s*;[^)]*\\)[\\s\\S]{0,500}?\\b[A-Za-z_]\\w*\\s*\\(`);
	if (!loop.test(source)) {return undefined;}
	const count = Number(countText);
	return Number.isSafeInteger(count) && count > 0 ? count : undefined;
}

export function detectTransformReduceExecutionPolicy(source: string): string | undefined {
    if (!/(?:std\s*::\s*)?transform_reduce\s*\(/.test(source)) {return undefined;}
    return source.match(/\b(?:std\s*::\s*)?execution\s*::\s*(seq|par|par_unseq|unseq)\b/)?.[1];
}

export function benchmarkWorkloadSizes(source: string, fallback: [number, number, number] = [64, 128, 256]): [number, number, number] {
	const count = detectFixedWorkloadElementCount(source);
	if (!count) {return fallback;}
	const sizes: [number, number, number] = [Math.floor(count / 4), Math.floor(count / 2), count];
	return sizes[0] > 0 && sizes[0] < sizes[1] && sizes[1] < sizes[2] ? sizes : fallback;
}
