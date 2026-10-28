import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

export interface CudaCompileConfiguration {
    cwd: string;
    arguments: string[];
    source: string;
    origin: string;
}

interface CompilationEntry { directory?: string; file?: string; command?: string; arguments?: string[]; }

export async function resolveCudaCompileConfiguration(workspaceRoot: string, sourceFile: string): Promise<CudaCompileConfiguration> {
    const commandsPath = path.join(workspaceRoot, 'compile_commands.json');
    try {
        const entries = JSON.parse(await readFile(commandsPath, 'utf8')) as CompilationEntry[];
        const entry = entries.find(item => item.file && samePath(path.resolve(item.directory || workspaceRoot, item.file), sourceFile));
        if (entry) {
            const cwd = path.resolve(entry.directory || workspaceRoot);
            const originalArgs = entry.arguments ? [...entry.arguments] : splitCommand(entry.command || '');
            const args = stripCompileInputAndOutput(originalArgs, entry.file ? path.resolve(cwd, entry.file) : sourceFile);
            args.push('-I', workspaceRoot, '-I', path.dirname(sourceFile));
            return { cwd, arguments: args, source: sourceFile, origin: `compile_commands.json (${commandsPath})` };
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw new Error(`Could not read project compile_commands.json: ${(error as Error).message}`);
        }
    }

    const args = ['-std=c++17', '-I', workspaceRoot, '-I', path.dirname(sourceFile)];
    const propertiesPath = path.join(workspaceRoot, '.vscode', 'c_cpp_properties.json');
    try {
        const config = JSON.parse(await readFile(propertiesPath, 'utf8')) as {
            configurations?: Array<{ includePath?: string[]; defines?: string[]; compilerArgs?: string[]; cppStandard?: string; }>
        };
        const settings = config.configurations?.[0];
        const expand = (value: string) => value.replace(/\$\{workspaceFolder\}/g, workspaceRoot).replace(/\$\{workspaceRoot\}/g, workspaceRoot);
        for (const include of settings?.includePath ?? []) {args.push('-I', expand(include));}
        for (const define of settings?.defines ?? []) {args.push(`-D${expand(define)}`);}
        for (const arg of settings?.compilerArgs ?? []) {args.push(expand(arg));}
        if (settings?.cppStandard) {
            args.splice(args.indexOf('-std=c++17'), 1, `-std=${settings.cppStandard}`);
        }
        return { cwd: path.dirname(sourceFile), arguments: args, source: sourceFile, origin: `.vscode/c_cpp_properties.json (${propertiesPath})` };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw new Error(`Could not read project CUDA build settings: ${(error as Error).message}`);
        }
    }
    return { cwd: path.dirname(sourceFile), arguments: args, source: sourceFile, origin: 'KernelPilot defaults; no compile_commands.json or C/C++ project properties were found' };
}

export function withCudaArchitecture(args: string[], architecture?: string): string[] {
    const result: string[] = [];
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '-arch' || arg === '--gpu-architecture') {index++; continue;}
        if (/^-arch=/.test(arg) || /^--gpu-architecture=/.test(arg) || /^-gencode(?:=|$)/.test(arg) || /^--generate-code/.test(arg)) {
            if (/^(?:-gencode|--generate-code)$/.test(arg)) {index++;}
            continue;
        }
        result.push(arg);
    }
    if (architecture) {result.push(`-arch=${architecture}`);}
    return result;
}

function stripCompileInputAndOutput(args: string[], sourceFile: string): string[] {
    const result: string[] = [];
    const compilerIndex = args.findIndex(arg => /(?:^|[\\/])(?:nvcc|clang\+\+|g\+\+)(?:\.exe)?$/i.test(arg));
    for (let index = Math.max(0, compilerIndex + 1); index < args.length; index++) {
        const arg = args[index];
        if (samePath(path.resolve(arg), sourceFile)) {continue;}
        if (['-o', '--output-file', '-MF', '-MT', '-MQ'].includes(arg)) {index++; continue;}
        if (['-c', '-dc', '--device-c', '-M', '-MM', '-MD', '-MMD', '-MP'].includes(arg)) {continue;}
        if (arg === '-o' || arg.startsWith('-o') && arg.length > 2) {continue;}
        result.push(arg);
    }
    return result;
}

function splitCommand(command: string): string[] {
    const parts: string[] = []; let current = ''; let quote = ''; let escaped = false;
    for (const char of command) {
        if (escaped) {current += char; escaped = false; continue;}
        if (char === '\\' && quote !== "'") {escaped = true; continue;}
        if (quote) {if (char === quote) {quote = '';} else {current += char;} continue;}
        if (char === '"' || char === "'") {quote = char; continue;}
        if (/\s/.test(char)) {if (current) {parts.push(current); current = '';}} else {current += char;}
    }
    if (current) {parts.push(current);}
    return parts;
}

function samePath(left: string, right: string): boolean {
    const normalizedLeft = path.normalize(path.resolve(left)); const normalizedRight = path.normalize(path.resolve(right));
    return process.platform === 'win32' ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase() : normalizedLeft === normalizedRight;
}
