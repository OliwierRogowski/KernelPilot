import * as assert from 'assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
	buildCandidateGpuDeviceMountArgs,
	buildCandidateGpuMetadataMountArgs,
	buildCandidateReadOnlyMountArgs,
	getAdditionalCudaMountLocations,
	runCandidateProgram
} from '../candidateRunner';

const execFileAsync = promisify(execFile);

suite('Candidate process runner', () => {
	test('does not add a CUDA alias mount below the existing /usr bind', () => {
		const cudaRootInsideUsr = getAdditionalCudaMountLocations('/usr/local/cuda-13.4');
		const cudaRootOutsideUsr = getAdditionalCudaMountLocations('/opt/cuda');
		assert.deepStrictEqual(cudaRootInsideUsr, []);
		assert.deepStrictEqual(cudaRootOutsideUsr, ['/opt/cuda']);
		const mounts = buildCandidateReadOnlyMountArgs(['/usr', '/lib', '/lib64', ...cudaRootInsideUsr]);
		assert.deepStrictEqual(mounts, [
			'--ro-bind', '/usr', '/usr',
			'--ro-bind', '/lib', '/lib',
			'--ro-bind', '/lib64', '/lib64'
		]);
		assert.ok(!mounts.includes('/usr/local/cuda'));
	});

	test('binds GPU devices and driver metadata without making metadata writable', () => {
		assert.deepStrictEqual(buildCandidateGpuDeviceMountArgs([
			'/dev/nvidia0', '/dev/nvidiactl', '/dev/nvidia-uvm', '/dev/nvidia-caps', '/dev/nvidia0'
		]), [
			'--dev-bind', '/dev/nvidia0', '/dev/nvidia0',
			'--dev-bind', '/dev/nvidiactl', '/dev/nvidiactl',
			'--dev-bind', '/dev/nvidia-uvm', '/dev/nvidia-uvm',
			'--dev-bind', '/dev/nvidia-caps', '/dev/nvidia-caps'
		]);
		assert.deepStrictEqual(buildCandidateGpuMetadataMountArgs([
			'/sys', '/proc/driver/nvidia', '/proc/driver/nvidia-caps'
		]), [
			'--ro-bind', '/sys', '/sys',
			'--ro-bind', '/proc/driver/nvidia', '/proc/driver/nvidia',
			'--ro-bind', '/proc/driver/nvidia-caps', '/proc/driver/nvidia-caps'
		]);
	});

	test('runs a disposable candidate with a reduced environment', async function () {
		if (process.platform !== 'linux') {this.skip();}
		const directory = await mkdtemp(path.join(tmpdir(), 'kernelpilot-runner-test-'));
		const key = 'KERNELPILOT_RUNNER_TEST_SECRET';
		const previous = process.env[key];
		process.env[key] = 'must-not-reach-candidate';
		try {
			const source = path.join(directory, 'candidate.cpp');
			const binary = path.join(directory, 'candidate');
			await writeFile(source, '#include <cstdlib>\n#include <iostream>\nint main() { std::cout << (std::getenv("KERNELPILOT_RUNNER_TEST_SECRET") ? "exposed" : "hidden") << "\\n"; }\n');
			await execFileAsync('g++', ['-std=c++17', source, '-o', binary], { timeout: 30000 });
			const result = await runCandidateProgram(binary, [], {
				cwd: directory, timeout: 10000, maxBuffer: 1024 * 1024
			});
			assert.strictEqual(result.stdout.trim(), 'hidden');
			assert.ok(['bubblewrap', 'bubblewrap-network-open', 'resource-limited'].includes(result.isolation));
		} finally {
			if (previous === undefined) {delete process.env[key];}
			else {process.env[key] = previous;}
			await rm(directory, { recursive: true, force: true });
		}
	});
});
