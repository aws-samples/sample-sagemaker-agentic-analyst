/**
 * Chronos-2 レスポンスを LLM + Code Interpreter 向けに整形する。
 *
 * 設計原則:
 * - LLM は summary（統計量＋トレンド）のみを参照して自然言語で解釈する
 * - Code Interpreter は p10/p50/p90 の full 配列と start/freq から x 軸を組み立てて fan chart を描画する
 *
 * なぜ full 配列を response に同梱しているか（S3 artifact を使わない理由）:
 * - Code Interpreter は Sandbox mode で S3 アクセス自体は可能だが、利用には Custom Code Interpreter
 *   の execution role が必要。execution role は Runtime 単位で共有されるため、プロジェクト/ユーザー
 *   境界を越えてクロスユーザーで artifact を読める IAM 穴になり、プロンプトインジェクションのリスクが高い
 * - 初期リリース想定（研究 §7.7: ≤100系列 × ≤1024点 ≈ 3MB）なら Gateway 6MB 制限に収まる
 * - tool response はそのセッションに閉じるため、IAM 経由のクロスユーザー漏洩経路は発生しない
 */

export interface ChronosPrediction {
  '0.1': number[] | number[][];
  '0.5': number[] | number[][];
  '0.9': number[] | number[][];
  item_id?: string;
  start?: string;
}

export interface ChronosResponse {
  predictions: ChronosPrediction[];
}

export interface ForecastSummaryStats {
  p50_mean: number;
  p50_min: number;
  p50_max: number;
  p50_end: number;
  trend: 'increasing' | 'slightly_increasing' | 'flat' | 'slightly_decreasing' | 'decreasing';
  uncertainty: 'low' | 'moderate' | 'high';
}

/**
 * 1 系列ぶんの予測結果。
 * - summary: LLM が自然言語で解釈する統計サマリ
 * - p10/p50/p90: Code Interpreter が fan chart を描画するための full 配列（length === prediction_length）
 * - start/freq: Code Interpreter が x 軸（timestamp）を組み立てるためのメタ情報
 */
export interface ForecastSeries {
  item_id?: string;
  start?: string;
  freq: string;
  p10: number[];
  p50: number[];
  p90: number[];
  summary: ForecastSummaryStats;
}

function mean(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}

function classifyTrend(series: number[]): ForecastSummaryStats['trend'] {
  if (series.length < 2) return 'flat';
  const first = series[0];
  const last = series[series.length - 1];
  const base = Math.max(Math.abs(first), 1e-9);
  const rel = (last - first) / base;
  if (rel > 0.2) return 'increasing';
  if (rel > 0.05) return 'slightly_increasing';
  if (rel < -0.2) return 'decreasing';
  if (rel < -0.05) return 'slightly_decreasing';
  return 'flat';
}

function classifyUncertainty(p10: number[], p50: number[], p90: number[]): ForecastSummaryStats['uncertainty'] {
  const widths = p50.map((m, i) => {
    const range = p90[i] - p10[i];
    return Math.abs(m) > 1e-9 ? range / Math.abs(m) : range;
  });
  const avg = mean(widths);
  if (avg < 0.2) return 'low';
  if (avg < 0.6) return 'moderate';
  return 'high';
}

/** 単変量（number[]）のみサポート。多変量は将来拡張（§7.7） */
function asUnivariate(v: number[] | number[][]): number[] {
  if (Array.isArray(v[0])) {
    throw new Error('Multivariate predictions are not supported in the initial release');
  }
  return v as number[];
}

/**
 * 入力 freq を、レスポンスで返す pandas 互換 freq にマップする。
 * - 'W' は pandas デフォルトで日曜終わり（W-SUN）。本ツールは SQL 側で date_trunc('week', ts)（月曜始まり）
 *   に集計する前提なので、レスポンスでは明示的に 'W-MON' を返し、Code Interpreter 側の
 *   pd.date_range が月曜起点で組み立てられるようにする。
 * - 他の freq はそのまま返す。
 */
function mapFreqForResponse(freq: string): string {
  const trimmed = freq.trim();
  if (trimmed === 'W') return 'W-MON';
  const match = trimmed.match(/^(\d+)W$/);
  if (match) return `${match[1]}W-MON`;
  return trimmed;
}

export function summarize(resp: ChronosResponse, freq: string): ForecastSeries[] {
  const responseFreq = mapFreqForResponse(freq);
  return resp.predictions.map((pred) => {
    const p10 = asUnivariate(pred['0.1']);
    const p50 = asUnivariate(pred['0.5']);
    const p90 = asUnivariate(pred['0.9']);
    return {
      item_id: pred.item_id,
      start: pred.start,
      freq: responseFreq,
      p10,
      p50,
      p90,
      summary: {
        p50_mean: mean(p50),
        p50_min: p50.reduce((a, b) => (a < b ? a : b), Infinity),
        p50_max: p50.reduce((a, b) => (a > b ? a : b), -Infinity),
        p50_end: p50[p50.length - 1],
        trend: classifyTrend(p50),
        uncertainty: classifyUncertainty(p10, p50, p90),
      },
    };
  });
}
