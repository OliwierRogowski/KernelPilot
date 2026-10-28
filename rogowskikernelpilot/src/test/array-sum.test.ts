import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const examplePath = path.resolve(__dirname, '../..', 'examples', 'array_sum.cpp');

function correctnessDriver(source: string): string {
    return `
#define main kernelpilot_array_sum_example_main
${source}
#undef main

int main() {
    for (std::size_t count : {64u, 128u, 256u}) {
        std::vector<int> values(count);
        long long expected = 0;
        for (std::size_t index = 0; index < count; ++index) {
            values[index] = static_cast<int>((index * 17) % 101) - 50;
            expected += values[index];
        }
        const long long actual = arraySum(values.data(), values.size());
        if (actual != expected) {
            std::cerr << "arraySum mismatch for " << count << ": expected " << expected
                      << ", got " << actual << '\\n';
            return 1;
        }
        std::cout << count << ',' << actual << '\\n';
    }
    return 0;
}
`;
}

async function compileAndRun(directory: string, name: string, source: string): Promise<string> {
    const sourcePath = path.join(directory, `${name}.cpp`);
    const executablePath = path.join(directory, name);
    await writeFile(sourcePath, source, 'utf8');
    await execFileAsync(process.env.CXX || 'g++', ['-std=c++17', '-O2', sourcePath, '-o', executablePath], { timeout: 30000 });
    const { stdout } = await execFileAsync(executablePath, [], { timeout: 10000 });
    return stdout;
}

suite('CPU array sum example correctness', () => {
    test('matches independent sums for three sizes and rejects a first-element omission', async () => {
        const source = await readFile(examplePath, 'utf8');
        const directory = await mkdtemp(path.join(os.tmpdir(), 'kernelpilot-array-sum-'));
        try {
            const validOutput = await compileAndRun(directory, 'valid', correctnessDriver(source));
            assert.deepStrictEqual(validOutput.trim().split(/\r?\n/), ['64,-238', '128,-231', '256,-189']);

            const mutatedSource = source.replace(
                'for (std::size_t index = 0; index < count; ++index)',
                'for (std::size_t index = 1; index < count; ++index)'
            );
            assert.notStrictEqual(mutatedSource, source, 'The mutation must change the arraySum loop.');
            const mutatedPath = path.join(directory, 'mutated.cpp');
            const mutatedExecutable = path.join(directory, 'mutated');
            await writeFile(mutatedPath, correctnessDriver(mutatedSource), 'utf8');
            await execFileAsync(process.env.CXX || 'g++', ['-std=c++17', '-O2', mutatedPath, '-o', mutatedExecutable], { timeout: 30000 });
            await assert.rejects(execFileAsync(mutatedExecutable, [], { timeout: 10000 }));
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
