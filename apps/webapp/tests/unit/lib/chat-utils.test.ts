import { describe, it, expect } from 'vitest';
import { parseImageEvent } from '@/lib/chat-utils';

describe('parseImageEvent', () => {
  it('画像イベントを正しくパースする', () => {
    const data = JSON.stringify({ type: 'image', data: 'base64data', mimeType: 'image/png' });
    const result = parseImageEvent(data);
    expect(result).toEqual({ type: 'image', data: 'base64data', mimeType: 'image/png' });
  });

  it('mimeTypeが省略された場合はimage/pngをデフォルトにする', () => {
    const data = JSON.stringify({ type: 'image', data: 'base64data' });
    const result = parseImageEvent(data);
    expect(result).toEqual({ type: 'image', data: 'base64data', mimeType: 'image/png' });
  });

  it('テキストチャンクに対してnullを返す', () => {
    const result = parseImageEvent('"hello world"');
    expect(result).toBeNull();
  });

  it('messagesメタデータに対してnullを返す', () => {
    const data = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });
    const result = parseImageEvent(data);
    expect(result).toBeNull();
  });

  it('不正なJSONに対してnullを返す', () => {
    const result = parseImageEvent('not json');
    expect(result).toBeNull();
  });

  it('dataフィールドがないオブジェクトに対してnullを返す', () => {
    const data = JSON.stringify({ type: 'image', mimeType: 'image/png' });
    const result = parseImageEvent(data);
    expect(result).toBeNull();
  });
});
