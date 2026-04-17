import { describe, it, expect } from 'vitest';
import { parseRowsToSeries } from '../../time-series-forecast/parse';

describe('parseRowsToSeries', () => {
  it("ts カラムが無ければエラー", () => {
    expect(() => parseRowsToSeries([{ y: '10' }], ['y'])).toThrow(/'ts'/);
  });

  it("y カラムが無ければエラー", () => {
    expect(() => parseRowsToSeries([{ ts: '2025-01-01' }], ['ts'])).toThrow(/'y'/);
  });

  it('日付のみ (YYYY-MM-DD) を UTC 00:00 としてパース', () => {
    const res = parseRowsToSeries([{ ts: '2025-01-01', y: '10' }], ['ts', 'y']);
    expect(res).toHaveLength(1);
    expect(res[0].ts.toISOString()).toBe('2025-01-01T00:00:00.000Z');
    expect(res[0].y).toBe(10);
    expect(res[0].itemId).toBeUndefined();
  });

  it('スペース区切り (YYYY-MM-DD HH:MM:SS) を UTC としてパース', () => {
    const res = parseRowsToSeries([{ ts: '2025-01-01 12:34:56', y: '10' }], ['ts', 'y']);
    expect(res[0].ts.toISOString()).toBe('2025-01-01T12:34:56.000Z');
  });

  it('ISO 8601 (Z 付き) はそのままパース', () => {
    const res = parseRowsToSeries([{ ts: '2025-01-01T12:34:56Z', y: '10' }], ['ts', 'y']);
    expect(res[0].ts.toISOString()).toBe('2025-01-01T12:34:56.000Z');
  });

  it('ISO 8601 (オフセット付き) はそのままパース', () => {
    const res = parseRowsToSeries([{ ts: '2025-01-01T12:34:56+09:00', y: '10' }], ['ts', 'y']);
    expect(res[0].ts.toISOString()).toBe('2025-01-01T03:34:56.000Z');
  });

  it('item_id カラムが存在すればセット', () => {
    const res = parseRowsToSeries(
      [
        { ts: '2025-01-01', y: '10', item_id: 'A' },
        { ts: '2025-01-01', y: '20', item_id: 'B' },
      ],
      ['ts', 'y', 'item_id'],
    );
    expect(res.map((r) => r.itemId)).toEqual(['A', 'B']);
  });

  it('空文字・不正値の行はスキップ', () => {
    const res = parseRowsToSeries(
      [
        { ts: '', y: '10' },
        { ts: '2025-01-01', y: '' },
        { ts: 'not-a-date', y: '10' },
        { ts: '2025-01-01', y: 'NaN' },
        { ts: '2025-01-02', y: '20' },
      ],
      ['ts', 'y'],
    );
    expect(res).toHaveLength(1);
    expect(res[0].y).toBe(20);
  });
});
