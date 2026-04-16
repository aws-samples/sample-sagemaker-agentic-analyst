import { readFileSync } from 'fs';

/**
 * .dockerignoreファイルをパースし、CDKのexcludeプロパティに渡せるパターン配列を返す。
 * コメント行、空行、否定パターン（!で始まる行）を除外する。
 */
export function parseDockerignore(filePath: string): string[] {
  return readFileSync(filePath, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'));
}
