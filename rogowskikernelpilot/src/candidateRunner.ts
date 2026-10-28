import { access, lstat, realpath, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execFileAsync = promisify(execFile);

export interface CandidateRunResult {
    stdout: string;
    stderr: string;
    isolation: 'bubblewrap' | 'bubblewrap-network-open' | 'resource-limited' | 'none';
    isolationDetails: string;
}

interface CandidateRunOptions {
    cwd: string;
    timeout: number;
    maxBuffer: number;
    allowGpu?: boolean;
    requireFilesystemIsolation?: boolean;
    allowOpenNetwork?: boolean;
}

export interface CandidateIsolationStatus {
    isolation: CandidateRunResult['isolation'];
    details: string;
}

export async function inspectCandidateIsolation(): Promise<CandidateIsolationStatus> {
    if (process.platform !== 'linux') {
        return { isolation: 'none', details: 'No tested filesystem/process sandbox is available on this platform.' };
    }
    const bwrap = await findProgram('bwrap');
    if (!bwrap) {return { isolation: 'none', details: 'Bubblewrap is not installed.' };}
    const prlimit = await findProgram('prlimit');
    // Do not apply RLIMIT_NPROC to Bubblewrap itself. It is a per-UID limit on
    // the host and may prevent user-namespace creation when the desktop user
    // already owns more than 256 processes. Apply it only after entering the
    // isolated user/PID namespaces, directly to the candidate process.
    const probeLimits = ['--as=2147483648', '--cpu=60', '--fsize=16777216', '--nofile=128'];
    const args = [
        '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts',
        '--ro-bind', '/usr', '/usr',
        ...(await exists('/lib') ? ['--ro-bind', '/lib', '/lib'] : []),
        ...(await exists('/lib64') ? ['--ro-bind', '/lib64', '/lib64'] : []),
        '--proc', '/proc', '--dev', '/dev', '--', '/usr/bin/true'
    ];
    try {
        await execFileAsync(prlimit ?? bwrap, prlimit ? [...probeLimits, '--', bwrap, ...args] : args,
            { timeout: 5000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C' } });
    } catch (error) {
        return {
            isolation: prlimit ? 'resource-limited' : 'none',
            details: `Bubblewrap filesystem/process preflight failed; candidate execution would retain host filesystem and network access. ${formatProbeError(error)}`
        };
    }
    try {
        await execFileAsync(prlimit ?? bwrap, prlimit
            ? [...probeLimits, '--', bwrap, '--unshare-user', '--unshare-net', '--ro-bind', '/usr', '/usr', ...(await exists('/lib') ? ['--ro-bind', '/lib', '/lib'] : []), ...(await exists('/lib64') ? ['--ro-bind', '/lib64', '/lib64'] : []), '--proc', '/proc', '--dev', '/dev', '--', '/usr/bin/true']
            : ['--unshare-user', '--unshare-net', '--ro-bind', '/usr', '/usr', ...(await exists('/lib') ? ['--ro-bind', '/lib', '/lib'] : []), ...(await exists('/lib64') ? ['--ro-bind', '/lib64', '/lib64'] : []), '--proc', '/proc', '--dev', '/dev', '--', '/usr/bin/true'],
        { timeout: 5000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C' } });
        return { isolation: 'bubblewrap', details: 'Bubblewrap filesystem/process and network namespaces are available.' };
    } catch (error) {
        return {
            isolation: 'bubblewrap-network-open',
            details: `Bubblewrap filesystem/process namespaces are available, but network isolation is unavailable. ${formatProbeError(error)}`
        };
    }
}

export async function runCandidateProgram(
    executable: string,
    args: string[],
    options: CandidateRunOptions
): Promise<CandidateRunResult> {
    if (options.requireFilesystemIsolation) {
        const status = await inspectCandidateIsolation();
        if (status.isolation === 'none' || status.isolation === 'resource-limited') {
            throw new Error(`Refusing to run untrusted candidate without filesystem/process isolation. ${status.details}`);
        }
        if (status.isolation === 'bubblewrap-network-open' && !options.allowOpenNetwork) {
            throw new Error(`Refusing to run candidate because network isolation is unavailable and no explicit network-access consent was recorded. ${status.details}`);
        }
    }
    const environment = {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        LANG: 'C',
        LC_ALL: 'C',
        HOME: options.cwd,
        TMPDIR: options.cwd
    };
    if (process.platform === 'linux') {
        const bwrap = await findProgram('bwrap');
        if (bwrap) {
            const prlimit = await findProgram('prlimit');
            const resourceLimits = ['--as=2147483648', '--cpu=60', '--fsize=16777216', '--nofile=128'];
            const preflight = async (arguments_: string[]) => {
                const command = prlimit ?? bwrap;
                const commandArguments = prlimit
                    ? [...resourceLimits, '--', bwrap, ...arguments_]
                    : arguments_;
                return execFileAsync(command, commandArguments, {
                    cwd: options.cwd, env: environment, timeout: 5000, maxBuffer: 1024 * 1024
                });
            };
            let sandboxAvailable = false;
            try {
                await preflight([
                    '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts',
                    '--ro-bind', '/usr', '/usr',
                    ...(await exists('/lib') ? ['--ro-bind', '/lib', '/lib'] : []),
                    ...(await exists('/lib64') ? ['--ro-bind', '/lib64', '/lib64'] : []),
                    '--proc', '/proc', '--dev', '/dev', '--', '/usr/bin/true'
                ]);
                sandboxAvailable = true;
            } catch {
                sandboxAvailable = false;
            }
            if (!sandboxAvailable) {
                return runWithResourceLimit(executable, args, options, environment,
                    'Bubblewrap namespaces are unavailable; filesystem and network access remain unrestricted.');
            }

            let networkNamespaceAvailable = false;
            try {
                await preflight([
                    '--unshare-user', '--unshare-net', '--ro-bind', '/usr', '/usr',
                    ...(await exists('/lib') ? ['--ro-bind', '/lib', '/lib'] : []),
                    ...(await exists('/lib64') ? ['--ro-bind', '/lib64', '/lib64'] : []),
                    '--proc', '/proc', '--dev', '/dev', '--', '/usr/bin/true'
                ]);
                networkNamespaceAvailable = true;
            } catch {
                networkNamespaceAvailable = false;
            }

            const mountLocations = ['/usr', '/lib', '/lib64'];
            if (options.allowGpu) {
                try {
                    const cudaRoot = await realpath('/usr/local/cuda');
                    const cudaRootStatus = await lstat(cudaRoot);
                    if (!cudaRootStatus.isSymbolicLink()) {
                        mountLocations.push(...getAdditionalCudaMountLocations(cudaRoot));
                    }
                } catch {
                    // A disappearing optional CUDA mount should not fail candidate setup.
                }
            }
            const mounts = buildCandidateReadOnlyMountArgs(mountLocations);
            if (await exists('/etc/ld.so.cache')) {
                mounts.push('--dir', '/etc', '--ro-bind', '/etc/ld.so.cache', '/etc/ld.so.cache');
            }
            const deviceMounts = options.allowGpu
                ? buildCandidateGpuDeviceMountArgs(await listNvidiaDevicePaths())
                : [];
            const gpuMetadataLocations: string[] = [];
            if (options.allowGpu) {
                if (await exists('/sys')) {
                    gpuMetadataLocations.push('/sys');
                }
                for (const location of ['/proc/driver/nvidia', '/proc/driver/nvidia-caps']) {
                    if (await exists(location)) {
                        gpuMetadataLocations.push(location);
                    }
                }
            }
            const gpuMetadataMounts = buildCandidateGpuMetadataMountArgs(gpuMetadataLocations);
            const workExecutable = path.posix.join('/work', path.basename(executable));
            const sandboxPrlimit = '/usr/bin/prlimit';
            if (prlimit && !(await exists(sandboxPrlimit))) {
                mounts.push('--ro-bind', prlimit, sandboxPrlimit);
            }
            const sandboxArgs = [
                '--die-with-parent', '--new-session',
                '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts',
                ...(networkNamespaceAvailable ? ['--unshare-net'] : []),
                ...mounts,
                '--proc', '/proc', '--dev', '/dev',
                ...gpuMetadataMounts,
                ...deviceMounts,
                '--tmpfs', '/tmp', '--bind', options.cwd, '/work', '--chdir', '/work',
                '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin',
                '--setenv', 'HOME', '/tmp', '--setenv', 'TMPDIR', '/tmp',
                '--setenv', 'LANG', 'C', '--setenv', 'LC_ALL', 'C',
                ...(options.allowGpu ? ['--setenv', 'LD_LIBRARY_PATH', '/usr/local/cuda/lib64:/usr/local/cuda/lib:/usr/local/cuda/lib64/stubs'] : []),
                '--',
                ...(prlimit ? [sandboxPrlimit, '--as=2147483648', '--cpu=60', '--fsize=16777216', '--nproc=256', '--nofile=128', '--', workExecutable] : [workExecutable]),
                ...args
            ];
            const command = prlimit ?? bwrap;
            const commandArgs = prlimit
                ? [...resourceLimits, '--', bwrap, ...sandboxArgs]
                : sandboxArgs;
            const result = await execFileAsync(command, commandArgs, {
                cwd: options.cwd,
                env: environment,
                maxBuffer: options.maxBuffer,
                timeout: options.timeout
            });
            return {
                stdout: result.stdout,
                stderr: result.stderr,
                isolation: networkNamespaceAvailable ? 'bubblewrap' : 'bubblewrap-network-open',
                isolationDetails: networkNamespaceAvailable
                    ? 'Filesystem, process, and network namespaces restricted.'
                    : 'Filesystem and process namespaces restricted; network namespace unavailable.'
            };
        }
        return runWithResourceLimit(executable, args, options, environment,
            'Bubblewrap is not installed; filesystem and network access remain unrestricted.');
    }

    const result = await execFileAsync(executable, args, {
        cwd: options.cwd, env: environment, maxBuffer: options.maxBuffer, timeout: options.timeout
    });
    return {
        stdout: result.stdout,
        stderr: result.stderr,
        isolation: 'none',
        isolationDetails: 'No OS sandbox or resource limiter is available; only subprocess timeout applies.'
    };
}

export function buildCandidateReadOnlyMountArgs(locations: readonly string[]): string[] {
    const seen = new Set<string>();
    return locations.flatMap(location => {
        if (seen.has(location)) {
            return [];
        }
        seen.add(location);
        return ['--ro-bind', location, location];
    });
}

export function getAdditionalCudaMountLocations(resolvedCudaRoot: string): string[] {
    const resolvedRoot = path.resolve(resolvedCudaRoot);
    const relativeToUsr = path.relative('/usr', resolvedRoot);
    const alreadyVisibleThroughUsr = relativeToUsr === '' ||
        (!relativeToUsr.startsWith(`..${path.sep}`) && relativeToUsr !== '..' && !path.isAbsolute(relativeToUsr));
    return alreadyVisibleThroughUsr ? [] : [resolvedRoot];
}

export function buildCandidateGpuDeviceMountArgs(devicePaths: readonly string[]): string[] {
    const uniquePaths = [...new Set(devicePaths)].filter(device =>
        device.startsWith('/dev/nvidia')
    );
    return uniquePaths.flatMap(device => ['--dev-bind', device, device]);
}

export function buildCandidateGpuMetadataMountArgs(locations: readonly string[]): string[] {
    return [...new Set(locations)].flatMap(location => ['--ro-bind', location, location]);
}

async function listNvidiaDevicePaths(): Promise<string[]> {
    try {
        const entries = await readdir('/dev', { withFileTypes: true });
        return entries.filter(entry => entry.name.startsWith('nvidia'))
            .map(entry => path.join('/dev', entry.name));
    } catch {
        return [];
    }
}

async function runWithResourceLimit(
    executable: string,
    args: string[],
    options: CandidateRunOptions,
    environment: NodeJS.ProcessEnv,
    fallbackDetails: string
): Promise<CandidateRunResult> {
    const prlimit = process.platform === 'linux' ? await findProgram('prlimit') : undefined;
    const command = prlimit ?? executable;
    const commandArgs = prlimit
        ? ['--as=2147483648', '--cpu=60', '--fsize=16777216', '--nproc=256', '--nofile=128', '--', executable, ...args]
        : args;
    const result = await execFileAsync(command, commandArgs, {
        cwd: options.cwd, env: environment, maxBuffer: options.maxBuffer, timeout: options.timeout
    });
    return {
        stdout: result.stdout,
        stderr: result.stderr,
        isolation: prlimit ? 'resource-limited' : 'none',
        isolationDetails: prlimit
            ? `${fallbackDetails} Process limits are applied, but filesystem and network access remain unrestricted.`
            : `${fallbackDetails} No OS resource limits are available beyond the subprocess timeout.`
    };
}

async function findProgram(name: string): Promise<string | undefined> {
    for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
        if (!directory) {continue;}
        const candidate = path.join(directory, name);
        if (await exists(candidate)) {return candidate;}
    }
    return undefined;
}

async function exists(location: string): Promise<boolean> {
    try {
        await access(location);
        return true;
    } catch {
        return false;
    }
}

function formatProbeError(error: unknown): string {
    const details = error as { message?: unknown; stderr?: unknown };
    const message = typeof details?.stderr === 'string' && details.stderr.trim()
        ? details.stderr.trim()
        : typeof details?.message === 'string' ? details.message : String(error);
    return `Probe diagnostic: ${message.replace(/\s+/g, ' ').slice(0, 500)}`;
}
