import * as assert from 'node:assert/strict';
import { getCudaMetricSamples, parseCudaMetricSamples, parseCudaVerificationResults, validateCudaRunOutput } from '../cudaMetrics';

function protocol(): string {
    return protocolWithSamples(5);
}

function protocolWithSamples(sampleCount: number): string {
    const lines: string[] = [];
    for (const size of [8, 16, 32]) {
        for (let sample = 0; sample < sampleCount; sample++) {
            lines.push(`KP_METRIC,CPU,compute,${size},${sample},0.2`);
            lines.push(`KP_METRIC,CPU,end_to_end,${size},${sample},0.3`);
            for (const [phase, milliseconds] of [['h2d', 0.1], ['kernel', 0.2], ['d2h', 0.1], ['end_to_end', 0.5]] as const) {
                lines.push(`KP_METRIC,CUDA,${phase},${size},${sample},${milliseconds}`);
            }
        }
    }
    return lines.join('\n');
}

suite('CUDA phase metrics protocol', () => {
    test('requires complete phase samples and preserves phase identities', () => {
        const parsed = parseCudaMetricSamples(protocol());
        assert.strictEqual(parsed.length, 3 * 5 * 6);
        assert.strictEqual(getCudaMetricSamples(parsed, 'CUDA', 'kernel').length, 15);
        assert.strictEqual(getCudaMetricSamples(parsed, 'CUDA', 'end_to_end')[0].milliseconds, 0.5);
    });

    test('accepts the 11 paired samples used by the alternating generic CUDA harness', () => {
        const parsed = parseCudaMetricSamples(protocolWithSamples(11), 11);
        assert.strictEqual(getCudaMetricSamples(parsed, 'CPU', 'compute').length, 33);
        assert.throws(() => parseCudaMetricSamples(protocol(), 11), /sample ids 0–10/);
    });

    test('rejects legacy aggregates, missing/duplicate phases, and invalid timings', () => {
        assert.throws(() => parseCudaMetricSamples('KP_BENCH_CUDA,8,0.2'), /No KP_METRIC/);
        assert.throws(() => parseCudaMetricSamples(protocol().replace('KP_METRIC,CUDA,h2d,8,0,0.1\n', '')), /h2d metrics/);
        assert.throws(() => parseCudaMetricSamples(protocol().replace('KP_METRIC,CUDA,kernel,8,0,0.2', 'KP_METRIC,CUDA,kernel,8,0,0')),
            /Invalid CUDA metric value/);
        assert.throws(() => parseCudaMetricSamples(`${protocol()}\nKP_METRIC,CUDA,kernel,8,0,0.2`), /Duplicate/);
    });

    test('requires runtime device confirmation and per-size correctness records', () => {
        const good = `${protocol()}\nKP_DEVICE,OK,1\nKP_VERIFY_RESULT,8,PASS,12\nKP_VERIFY_RESULT,16,PASS,24\nKP_VERIFY_RESULT,32,PASS,48\nKP_VERIFY,OK`;
        assert.deepStrictEqual(validateCudaRunOutput(good), [8, 16, 32]);
        assert.throws(() => validateCudaRunOutput(good.replace('KP_DEVICE,OK,1', 'KP_DEVICE,FAIL,0')), /usable device/);
        assert.throws(() => validateCudaRunOutput(good.replace('KP_VERIFY_RESULT,16,PASS,24\n', '')), /three per-size/);
        assert.throws(() => validateCudaRunOutput(good.replace('KP_VERIFY_RESULT,16,PASS,24', 'KP_VERIFY_RESULT,16,FAIL,24')), /Invalid CUDA correctness record/);
    });

    test('rejects a mutated array-sum checksum against an independent expected sum', () => {
        const sizes = [64, 128, 256];
        const expected = sizes.map(size => {
            let checksum = 0;
            for (let index = 0; index < size; index++) {
                checksum += ((index * 17) % 101) - 50;
            }
            return { size, checksum };
        });
        const records = [
            'KP_VERIFY_RESULT,64,PASS,-238',
            'KP_VERIFY_RESULT,128,PASS,-231',
            'KP_VERIFY_RESULT,256,PASS,-189'
        ].join('\n');
        const assertExpectedSums = (stdout: string) => assert.deepStrictEqual(parseCudaVerificationResults(stdout), expected);

        assert.doesNotThrow(() => assertExpectedSums(records));
        let omittedFirstValueSum = 0;
        for (let index = 1; index < 64; index++) {
            omittedFirstValueSum += ((index * 17) % 101) - 50;
        }
        assert.strictEqual(omittedFirstValueSum, -188);
        assert.throws(() => assertExpectedSums(records.replace('KP_VERIFY_RESULT,64,PASS,-238',
            `KP_VERIFY_RESULT,64,PASS,${omittedFirstValueSum}`)));
    });
});
