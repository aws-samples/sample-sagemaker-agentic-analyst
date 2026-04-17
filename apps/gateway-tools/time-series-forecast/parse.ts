/**
 * Athena 結果行 → SeriesRow[] へのパース。
 * ts/y/item_id エイリアス検証、タイムスタンプと数値の正規化を担う。
 */

import type { SeriesRow } from './fill';

/** Athena の ts 文字列を Date に変換。失敗時は null */
function parseTs(tsStr: string): Date | null {
  // 想定フォーマット:
  //   - '2025-01-01'
  //   - '2025-01-01 12:34:56'
  //   - '2025-01-01T12:34:56Z' / '2025-01-01T12:34:56+09:00'
  const normalized = tsStr.includes('T')
    ? tsStr
    : tsStr.replace(' ', 'T') + (tsStr.length <= 10 ? 'T00:00:00Z' : 'Z');
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseRowsToSeries(rows: Record<string, string>[], columns: string[]): SeriesRow[] {
  if (!columns.includes('ts')) throw new Error("SQL must alias the timestamp column as 'ts' (e.g. `order_date AS ts`)");
  if (!columns.includes('y')) throw new Error("SQL must alias the value column as 'y' (e.g. `SUM(sales_amount) AS y`)");
  const hasItemId = columns.includes('item_id');

  const out: SeriesRow[] = [];
  for (const row of rows) {
    const tsStr = row['ts'];
    const yStr = row['y'];
    if (!tsStr || yStr === undefined || yStr === '') continue;
    const ts = parseTs(tsStr);
    if (!ts) continue;
    const y = Number(yStr);
    if (!Number.isFinite(y)) continue;
    out.push({ ts, y, itemId: hasItemId ? row['item_id'] : undefined });
  }
  return out;
}
