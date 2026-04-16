/** SSEイベントデータが画像イベントかどうかを判定し、画像データを抽出する */
export function parseImageEvent(data: string): { type: 'image'; data: string; mimeType: string } | null {
  try {
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === 'object' && parsed.type === 'image' && typeof parsed.data === 'string') {
      return {
        type: 'image',
        data: parsed.data,
        mimeType: parsed.mimeType || 'image/png',
      };
    }
  } catch {
    // JSONパース失敗 → 画像イベントではない
  }
  return null;
}
