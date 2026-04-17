import { describe, it, expect } from 'vitest';
import { summarize, type ChronosResponse } from '../../time-series-forecast/summarize';

const mkResp = (p10: number[], p50: number[], p90: number[], itemId?: string, start?: string): ChronosResponse => ({
  predictions: [
    {
      '0.1': p10,
      '0.5': p50,
      '0.9': p90,
      ...(itemId ? { item_id: itemId } : {}),
      ...(start ? { start } : {}),
    },
  ],
});

describe('summarize', () => {
  it('p10/p50/p90 の full 配列をそのまま返す', () => {
    const resp = mkResp([1, 2, 3, 4, 5], [10, 20, 30, 40, 50], [11, 22, 33, 44, 55]);
    const res = summarize(resp, 'D');
    expect(res[0].p10).toEqual([1, 2, 3, 4, 5]);
    expect(res[0].p50).toEqual([10, 20, 30, 40, 50]);
    expect(res[0].p90).toEqual([11, 22, 33, 44, 55]);
  });

  it('freq はレスポンスにそのまま含まれる', () => {
    const resp = mkResp([1, 2, 3], [10, 20, 30], [11, 22, 33]);
    const res = summarize(resp, 'MS');
    expect(res[0].freq).toBe('MS');
  });

  it("入力 freq='W' は 'W-MON' に正規化される（SQL 側が月曜起点のため）", () => {
    const resp = mkResp([1], [10], [11]);
    expect(summarize(resp, 'W')[0].freq).toBe('W-MON');
    expect(summarize(resp, '2W')[0].freq).toBe('2W-MON');
  });

  it('start はレスポンスに存在する場合のみ含まれる', () => {
    const respWith = mkResp([1], [10], [11], undefined, '2025-04-17T00:00:00');
    expect(summarize(respWith, 'D')[0].start).toBe('2025-04-17T00:00:00');
    const respWithout = mkResp([1], [10], [11]);
    expect(summarize(respWithout, 'D')[0].start).toBeUndefined();
  });

  it('summary の統計量が正しい', () => {
    const resp = mkResp([1, 2, 3], [10, 20, 30], [11, 22, 33]);
    const res = summarize(resp, 'D');
    expect(res[0].summary.p50_mean).toBe(20);
    expect(res[0].summary.p50_min).toBe(10);
    expect(res[0].summary.p50_max).toBe(30);
    expect(res[0].summary.p50_end).toBe(30);
  });

  it('増加トレンドを検出', () => {
    const resp = mkResp([1, 2, 3], [10, 20, 30], [11, 22, 33]);
    const res = summarize(resp, 'D');
    expect(res[0].summary.trend).toBe('increasing');
  });

  it('フラットなトレンドを検出', () => {
    const resp = mkResp([9, 9, 9], [10, 10.2, 10.1], [11, 11, 11]);
    const res = summarize(resp, 'D');
    expect(res[0].summary.trend).toBe('flat');
  });

  it('減少トレンドを検出', () => {
    const resp = mkResp([1, 1, 1], [100, 50, 20], [110, 60, 30]);
    const res = summarize(resp, 'D');
    expect(res[0].summary.trend).toBe('decreasing');
  });

  it('不確実性が広い場合は high', () => {
    const resp = mkResp([1, 1, 1], [10, 10, 10], [50, 50, 50]);
    const res = summarize(resp, 'D');
    expect(res[0].summary.uncertainty).toBe('high');
  });

  it('不確実性が狭い場合は low', () => {
    const resp = mkResp([9.9, 9.9, 9.9], [10, 10, 10], [10.1, 10.1, 10.1]);
    const res = summarize(resp, 'D');
    expect(res[0].summary.uncertainty).toBe('low');
  });

  it('item_id がレスポンスに含まれる', () => {
    const resp = mkResp([1], [10], [11], 'product_A');
    const res = summarize(resp, 'D');
    expect(res[0].item_id).toBe('product_A');
  });

  it('多変量予測はエラー', () => {
    const resp: ChronosResponse = {
      predictions: [
        {
          '0.1': [
            [1, 2],
            [3, 4],
          ],
          '0.5': [
            [1, 2],
            [3, 4],
          ],
          '0.9': [
            [1, 2],
            [3, 4],
          ],
        },
      ],
    };
    expect(() => summarize(resp, 'D')).toThrow(/Multivariate/);
  });
});
