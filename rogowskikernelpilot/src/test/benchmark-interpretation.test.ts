import * as assert from 'node:assert/strict';
import { interpretMatchedTimings, measuredBenchmarkRecommendation, scenarioChangeHypotheses } from '../benchmarkInterpretation';

suite('Data-driven benchmark interpretation', () => {
    const points = (size: number, values: number[], ids = values.map((_, i) => i)) => values.map((milliseconds, i) => ({ size, sample: ids[i], milliseconds }));
    test('reports consistently lower CUDA paired samples without inventing a threshold', () => {
        const cpu = [4_194_304, 8_388_608, 16_777_216].flatMap((size, i) => points(size, [0.9, 0.95, 1, 1.04, 1.1].map(factor => [1.635, 3.656, 7.078][i] * factor)));
        const cuda = [4_194_304, 8_388_608, 16_777_216].flatMap((size, i) => points(size, [0.9, 0.95, 1, 1.04, 1.1].map(factor => [1.6, 3.241, 6.175][i] * factor)));
        const report = interpretMatchedTimings(cpu, cuda, 'end-to-end↔end-to-end');
        assert.match(report, /CUDA median is lower at every measured size/);
        assert.match(report, /CPU: 0\/5/);
        assert.match(report, /do not extrapolate beyond measured sizes/);
    });
    test('reports CPU as the statistically supported direction when all pairs favor CPU', () => {
        const report = interpretMatchedTimings(points(8, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), points(8, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), 'end-to-end↔end-to-end');
        assert.match(report, /CPU: 11\/11/);
        assert.match(report, /CPU at 1 sizes/);
        assert.doesNotMatch(report, /favors CUDA at 1 sizes/);
    });
    test('reports ties and pairs by sample ID, independent of array order', () => {
        const cpu = points(8, [10, 20, 30], [2, 0, 1]);
        const cuda = points(8, [20, 10, 30], [1, 2, 0]);
        const report = interpretMatchedTimings(cpu, cuda, 'end-to-end↔end-to-end');
        assert.match(report, /matched pairs=3/);
        assert.match(report, /ties: 1/);
    });
    test('counts unmatched pairs and leaves fewer than five pairs unresolved', () => {
        const report = interpretMatchedTimings(points(8, [1, 2, 3, 4, 5], [0, 1, 2, 3, 4]), points(8, [1, 2, 3], [2, 3, 9]), 'end-to-end↔end-to-end');
        assert.match(report, /matched pairs=2, unmatched=3/);
        assert.match(report, /Some pairs are missing/);
    });
    test('does not call lower medians a stable advantage when ranges overlap', () => {
        const report = interpretMatchedTimings(points(4, [1.4, 1.55, 1.635, 1.8, 2]), points(4, [.2, .35, .8, 1.3, 1.9]), 'end-to-end↔end-to-end');
        assert.match(report, /CUDA median is lower/);
        assert.match(report, /min–max ranges overlap/);
        assert.match(report, /does not establish a stable advantage/);
    });
    test('keeps data residency and memory alternatives as separate unmeasured experiments', () => {
        const report = scenarioChangeHypotheses();
        assert.match(report, /generate data on GPU and include equivalent CPU data-generation cost/);
        assert.match(report, /retain data on-device across later operations/);
        assert.match(report, /already uses pinned host buffers and still measures H2D/);
    });
    test('reports missing CUDA as unresolved in English', () => {
        const report = measuredBenchmarkRecommendation([], [], [], [], false, 'CUDA adapter compilation failed');
        assert.match(report, /comparison is unresolved/);
        assert.match(report, /CUDA adapter compilation failed/);
        assert.doesNotMatch(report, /CPU advantage|GPU advantage/);
    });
});
