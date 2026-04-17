import { describe, it, expect } from 'vitest';
import { fillSeries, freqToStepFn, type SeriesRow } from '../../time-series-forecast/fill';

describe('freqToStepFn', () => {
  it('日次で+1日', () => {
    const step = freqToStepFn('D');
    const d = new Date('2025-01-01T00:00:00Z');
    expect(step(d).toISOString()).toBe('2025-01-02T00:00:00.000Z');
  });

  it('月次 MS で+1ヶ月（月初）', () => {
    const step = freqToStepFn('MS');
    const d = new Date('2025-01-15T00:00:00Z');
    expect(step(d).toISOString()).toBe('2025-02-01T00:00:00.000Z');
  });

  it('時間次 1h で+1時間', () => {
    const step = freqToStepFn('1h');
    const d = new Date('2025-01-01T00:00:00Z');
    expect(step(d).toISOString()).toBe('2025-01-01T01:00:00.000Z');
  });

  it('2W で+14日', () => {
    const step = freqToStepFn('2W');
    const d = new Date('2025-01-01T00:00:00Z');
    expect(step(d).toISOString()).toBe('2025-01-15T00:00:00.000Z');
  });

  it('未対応 freq 単位で関数を呼ぶとエラー', () => {
    const step = freqToStepFn('Y');
    expect(() => step(new Date('2025-01-01T00:00:00Z'))).toThrow(/Unsupported freq unit/);
  });

  it('不正な freq 文字列はエラー', () => {
    expect(() => freqToStepFn('!!!')).toThrow(/Unsupported freq/);
  });
});

describe('fillSeries', () => {
  const mk = (isoDate: string, y: number, itemId?: string): SeriesRow => ({
    ts: new Date(isoDate + 'T00:00:00Z'),
    y,
    itemId,
  });

  it('日次で欠損なしならそのまま', () => {
    const rows = [mk('2025-01-01', 1), mk('2025-01-02', 2), mk('2025-01-03', 3)];
    const res = fillSeries(rows, 'D', 'zero');
    expect(res).toHaveLength(1);
    expect(res[0].values).toEqual([1, 2, 3]);
    expect(res[0].filledCount).toBe(0);
    expect(res[0].start.toISOString()).toBe('2025-01-01T00:00:00.000Z');
    expect(res[0].end.toISOString()).toBe('2025-01-03T00:00:00.000Z');
  });

  it('zero ポリシーで欠損を 0 埋め', () => {
    const rows = [mk('2025-01-01', 10), mk('2025-01-04', 40)]; // 01-02, 01-03 が欠損
    const res = fillSeries(rows, 'D', 'zero');
    expect(res[0].values).toEqual([10, 0, 0, 40]);
    expect(res[0].filledCount).toBe(2);
  });

  it('forward_fill ポリシーで直前値を使用', () => {
    const rows = [mk('2025-01-01', 10), mk('2025-01-04', 40)];
    const res = fillSeries(rows, 'D', 'forward_fill');
    expect(res[0].values).toEqual([10, 10, 10, 40]);
  });

  it('error ポリシーで欠損があれば例外', () => {
    const rows = [mk('2025-01-01', 10), mk('2025-01-04', 40)];
    expect(() => fillSeries(rows, 'D', 'error')).toThrow(/Missing timestamp/);
  });

  it('item_id で複数系列にグルーピング', () => {
    const rows = [mk('2025-01-01', 1, 'A'), mk('2025-01-02', 2, 'A'), mk('2025-01-01', 10, 'B')];
    const res = fillSeries(rows, 'D', 'zero');
    expect(res).toHaveLength(2);
    const a = res.find((s) => s.itemId === 'A')!;
    const b = res.find((s) => s.itemId === 'B')!;
    expect(a.values).toEqual([1, 2]);
    expect(b.values).toEqual([10]);
  });

  it('ts の順序が逆でも昇順にソートされる', () => {
    const rows = [mk('2025-01-03', 3), mk('2025-01-01', 1), mk('2025-01-02', 2)];
    const res = fillSeries(rows, 'D', 'zero');
    expect(res[0].values).toEqual([1, 2, 3]);
  });

  it('月次 MS で補完される', () => {
    const rows = [
      { ts: new Date('2025-01-01T00:00:00Z'), y: 10 },
      { ts: new Date('2025-04-01T00:00:00Z'), y: 40 }, // 2, 3 月が欠損
    ];
    const res = fillSeries(rows, 'MS', 'zero');
    expect(res[0].values).toEqual([10, 0, 0, 40]);
  });
});
