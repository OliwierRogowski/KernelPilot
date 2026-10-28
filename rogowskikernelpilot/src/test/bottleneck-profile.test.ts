import * as assert from 'assert';
import { analyzeBottlenecks, profileExperiment, type ProfilePhaseSample } from '../bottleneckProfile';

function sampleSet(values: Partial<Record<'h2d' | 'kernel' | 'd2h', number[]>>, n = 1024): ProfilePhaseSample[] {
    return Object.entries(values).flatMap(([phase, times]) => (times ?? []).map((milliseconds, sample) => ({
        phase: phase as 'h2d' | 'kernel' | 'd2h', size: n, sample, milliseconds
    })));
}

suite('Bottleneck profiling analysis', () => {
    const flat = (value: number) => Array(11).fill(value) as number[];
    test('identifies clear H2D dominance and proposes only a measured follow-up hypothesis', () => {
        const finding = analyzeBottlenecks(sampleSet({ h2d: flat(4), kernel: flat(1), d2h: flat(.1) }), true)[0];
        assert.strictEqual(finding.phase, 'h2d');
        assert.match(finding.reason, /H2D 11\/11/);
        assert.match(profileExperiment(finding), /only if source semantics permit/);
    });
    test('identifies kernel as median leader while counting D2H sample wins correctly', () => {
        const kernel = flat(9).map((value, i) => i === 1 ? .009216 : value);
        const d2h = flat(.001).map((value, i) => i === 1 ? .011008 : value);
        const finding = analyzeBottlenecks(sampleSet({ h2d: flat(.002), kernel, d2h }), true)[0];
        assert.strictEqual(finding.medianLeader, 'kernel');
        assert.strictEqual(finding.winsByPhase.kernel, 10);
        assert.strictEqual(finding.winsByPhase.d2h, 1);
        assert.doesNotMatch(finding.reason, /kernel 11\/11/);
    });
    test('detects clear D2H time dominance without inferring hardware saturation', () => {
        const finding = analyzeBottlenecks(sampleSet({ h2d: flat(.1), kernel: flat(.2), d2h: flat(3) }), true)[0];
        assert.strictEqual(finding.phase, 'd2h');
        assert.match(finding.reason, /not evidence of a bandwidth/);
    });
    test('reports one setup observation separately and unresolved', () => {
        const finding = analyzeBottlenecks(sampleSet({ h2d: flat(1), kernel: flat(.2), d2h: flat(.1) }).concat({ phase: 'preparation_allocation', size: 1024, sample: 0, milliseconds: .6 }), true)[0];
        assert.strictEqual(finding.phase, 'h2d');
        assert.strictEqual(finding.completeSampleCount, 11);
    });
    test('reports missing CUDA, missing phase records, zero times and ambiguous outcomes as unresolved', () => {
        assert.strictEqual(analyzeBottlenecks([], false)[0].status, 'unresolved');
        assert.strictEqual(analyzeBottlenecks(sampleSet({ h2d: flat(1) }), true)[0].status, 'unresolved');
        assert.strictEqual(analyzeBottlenecks(sampleSet({ h2d: [0, ...flat(1).slice(1)], kernel: flat(.2), d2h: flat(.1) }), true)[0].status, 'unresolved');
        assert.strictEqual(analyzeBottlenecks(sampleSet({ h2d: flat(1), kernel: flat(1), d2h: flat(.8) }), true)[0].status, 'unresolved');
    });
    test('does not use unmatched phase records as a complete sample group', () => {
        const rows = sampleSet({ h2d: flat(4), kernel: flat(1), d2h: flat(.1) }).filter(row => !(row.phase === 'd2h' && row.sample === 0));
        const finding = analyzeBottlenecks(rows, true)[0];
        assert.strictEqual(finding.status, 'unresolved');
        assert.strictEqual(finding.missingSamples, 1);
    });
});
