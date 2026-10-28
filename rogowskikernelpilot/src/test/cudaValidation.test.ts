import * as assert from 'node:assert/strict';
import { compareCudaRuns, parseHarnessOutput } from '../cudaValidation';

suite('CUDA correctness and benchmark report validation', () => {
    test('parses synchronized harness protocol records and requires positive statistics', () => {
        const parsed = parseHarnessOutput('KP_RESULT,small,PASS,0.10,0.12\nKP_RESULT,medium,PASS,0.40,0.45\nKP_RESULT,large,PASS,1.20,1.30\n');
        assert.strictEqual(parsed.length, 3);
        assert.throws(() => parseHarnessOutput('KP_RESULT,small,PASS,0,0'), /Invalid benchmark statistics/);
        assert.throws(() => parseHarnessOutput('no measurements'), /no KP_RESULT records/);
    });

    test('requires correctness on both versions and rejects regressions', () => {
        const baseline = parseHarnessOutput('KP_RESULT,s,PASS,10,11\nKP_RESULT,m,PASS,20,22\nKP_RESULT,l,PASS,30,33');
        const fast = parseHarnessOutput('KP_RESULT,s,PASS,8,9\nKP_RESULT,m,PASS,16,17\nKP_RESULT,l,PASS,24,25');
        assert.strictEqual(compareCudaRuns(baseline, fast).status, 'accepted');
        const wrong = parseHarnessOutput('KP_RESULT,s,PASS,8,9\nKP_RESULT,m,FAIL,16,17\nKP_RESULT,l,PASS,24,25');
        assert.strictEqual(compareCudaRuns(baseline, wrong).status, 'correctness_failed');
        const slow = parseHarnessOutput('KP_RESULT,s,PASS,12,13\nKP_RESULT,m,PASS,25,27\nKP_RESULT,l,PASS,40,42');
        assert.strictEqual(compareCudaRuns(baseline, slow).status, 'performance_regression');
        assert.strictEqual(compareCudaRuns(baseline, fast.slice(0, 2)).medianSpeedup, null);
        const noisy = parseHarnessOutput('KP_RESULT,s,PASS,8,10\nKP_RESULT,m,PASS,16,20\nKP_RESULT,l,PASS,24,30');
        assert.strictEqual(compareCudaRuns(baseline, noisy).status, 'cannot_confirm');
    });
});
