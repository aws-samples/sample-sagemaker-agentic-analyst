/**
 * 時系列データの等間隔化・前処理ロジック
 *
 * Chronos-2 は等間隔タイムスタンプを前提とするため、SQL 結果の欠損期間を補完する。
 * タイムゾーンは Asia/Tokyo で統一。
 */

export type FillPolicy = 'zero' | 'forward_fill' | 'error';

/** pandas 互換 freq 文字列を、次のタイムスタンプを計算する関数に変換 */
export function freqToStepFn(freq: string): (d: Date) => Date {
  // 代表的な offset alias のみサポート（初期リリース）。
  // 注意: 'M'/'Q' は pandas 本来では「月末/四半期末」だが、本実装では 'MS'/'QS'（月初/四半期初）と同じ扱い。
  // SQL 側で date_trunc('month'|'quarter', ts) を使って月初/四半期初に揃えることを前提とする。
  // ユーザーが月末データを持ち込んで 'M' を指定すると start が 1 日目にスライドする点に注意。
  const trimmed = freq.trim();
  const match = trimmed.match(/^(\d*)([A-Za-z]+)$/);
  if (!match) throw new Error(`Unsupported freq: ${freq}`);
  const n = match[1] ? parseInt(match[1], 10) : 1;
  const unit = match[2];

  return (d: Date) => {
    const next = new Date(d.getTime());
    switch (unit) {
      case 'min':
      case 'T':
        next.setUTCMinutes(next.getUTCMinutes() + n);
        return next;
      case 'h':
      case 'H':
        next.setUTCHours(next.getUTCHours() + n);
        return next;
      case 'D':
        next.setUTCDate(next.getUTCDate() + n);
        return next;
      case 'W':
        next.setUTCDate(next.getUTCDate() + 7 * n);
        return next;
      case 'MS':
      case 'M':
        next.setUTCMonth(next.getUTCMonth() + n);
        next.setUTCDate(1);
        return next;
      case 'QS':
      case 'Q':
        next.setUTCMonth(next.getUTCMonth() + 3 * n);
        next.setUTCDate(1);
        return next;
      default:
        throw new Error(`Unsupported freq unit: ${unit}`);
    }
  };
}

/** 2つのタイムスタンプが同じか判定（ms 単位） */
function sameTime(a: Date, b: Date): boolean {
  return a.getTime() === b.getTime();
}

export interface SeriesRow {
  ts: Date;
  y: number;
  itemId?: string;
}

export interface FilledSeries {
  itemId: string | undefined;
  start: Date;
  end: Date;
  values: number[];
  originalCount: number;
  filledCount: number;
}

/**
 * 系列ごとに等間隔化して補完する。
 * - 系列内で ts 昇順ソート → 最小〜最大範囲で freq に沿った完全タイムスタンプ列を生成 → 欠損を fill_missing_policy で埋める
 * - ts の重複は後勝ちで上書き
 */
export function fillSeries(rows: SeriesRow[], freq: string, policy: FillPolicy): FilledSeries[] {
  const step = freqToStepFn(freq);

  // item_id でグルーピング
  const groups = new Map<string | undefined, SeriesRow[]>();
  for (const r of rows) {
    const arr = groups.get(r.itemId);
    if (arr) arr.push(r);
    else groups.set(r.itemId, [r]);
  }

  const out: FilledSeries[] = [];
  for (const [itemId, list] of groups) {
    list.sort((a, b) => a.ts.getTime() - b.ts.getTime());
    // 重複は後勝ち
    const byTime = new Map<number, number>();
    for (const r of list) byTime.set(r.ts.getTime(), r.y);

    const start = list[0].ts;
    const end = list[list.length - 1].ts;
    const values: number[] = [];
    let filled = 0;
    let last: number | undefined;
    let current = start;
    while (current.getTime() <= end.getTime()) {
      const v = byTime.get(current.getTime());
      if (v !== undefined) {
        values.push(v);
        last = v;
      } else {
        if (policy === 'error') {
          throw new Error(`Missing timestamp detected at ${current.toISOString()} for item_id=${itemId ?? '(none)'}`);
        }
        // forward_fill かつ先頭が欠損の場合は last が undefined。設計上 current=start=list[0].ts なので通常到達しない
        const filler = policy === 'forward_fill' && last !== undefined ? last : 0;
        values.push(filler);
        filled++;
      }
      const next = step(current);
      if (sameTime(next, current)) break; // 無限ループ防止（freqToStepFn が同値を返す不正ケースへの保険）
      current = next;
    }

    out.push({ itemId, start, end, values, originalCount: byTime.size, filledCount: filled });
  }

  return out;
}
