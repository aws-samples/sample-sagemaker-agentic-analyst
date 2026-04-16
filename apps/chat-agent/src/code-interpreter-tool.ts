import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import {
  BedrockAgentCoreClient,
  StartCodeInterpreterSessionCommand,
  InvokeCodeInterpreterCommand,
  StopCodeInterpreterSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';

const CODE_INTERPRETER_ID = 'aws.codeinterpreter.v1';
const SESSION_TIMEOUT_SECONDS = 900; // 15分

const client = new BedrockAgentCoreClient({
  region: process.env.AWS_REGION || 'ap-northeast-1',
});

// 会話セッションID → Code InterpreterセッションIDのマッピング
const sessionMap = new Map<string, string>();

async function getOrCreateSession(conversationSessionId: string): Promise<string> {
  const existing = sessionMap.get(conversationSessionId);
  if (existing) return existing;

  const response = await client.send(
    new StartCodeInterpreterSessionCommand({
      codeInterpreterIdentifier: CODE_INTERPRETER_ID,
      name: `chat-${conversationSessionId.slice(0, 8)}`,
      sessionTimeoutSeconds: SESSION_TIMEOUT_SECONDS,
    }),
  );

  const sessionId = response.sessionId!;
  sessionMap.set(conversationSessionId, sessionId);
  // セッションタイムアウトに合わせてMapからも自動削除
  setTimeout(() => sessionMap.delete(conversationSessionId), SESSION_TIMEOUT_SECONDS * 1000);
  return sessionId;
}

export interface CodeInterpreterImage {
  data: string; // base64
  mimeType: string;
}

export interface CodeInterpreterResult {
  text: string;
  images: CodeInterpreterImage[];
}

/**
 * Code Interpreterツールを作成する。
 * 会話セッションIDに紐付いたCode Interpreterセッションを再利用する。
 * imageBuffer: ツール実行中に取得した画像を蓄積する外部バッファ
 */
export function createCodeInterpreterTool(conversationSessionId: string, imageBuffer: CodeInterpreterImage[]) {
  return tool({
    name: 'code_interpreter',
    description: `Pythonコードを安全なサンドボックス環境で実行し、データ分析・可視化を行う。
プリインストール済みライブラリ: matplotlib, plotly, seaborn, pandas, numpy, pillow, bokeh, matplotlib-venn
グラフを生成する場合は plt.savefig('chart.png', dpi=100, bbox_inches='tight') でカレントディレクトリに保存すること。絶対パス(/tmp等)は使わない。plt.show()は使わない。
日本語フォントは利用不可のため、グラフのラベル・タイトルは英語で記述すること。`,
    inputSchema: z.object({
      code: z.string().describe('実行するPythonコード'),
      language: z.enum(['python']).default('python').describe('プログラミング言語（現在はpythonのみ）'),
    }),
    callback: async (input): Promise<string> => {
      let sessionId: string;
      try {
        sessionId = await getOrCreateSession(conversationSessionId);
      } catch (err) {
        console.error('[CodeInterpreter] session creation failed:', err);
        return `Code Interpreterセッション作成エラー: ${err instanceof Error ? err.message : String(err)}`;
      }

      const response = await client.send(
        new InvokeCodeInterpreterCommand({
          codeInterpreterIdentifier: CODE_INTERPRETER_ID,
          sessionId,
          name: 'executeCode',
          arguments: {
            language: input.language ?? 'python',
            code: input.code,
          },
        }),
      );

      // ストリームからresultイベントを収集
      const texts: string[] = [];
      const images: CodeInterpreterImage[] = [];
      let isError = false;

      if (response.stream) {
        for await (const event of response.stream) {
          if ('result' in event && event.result) {
            const result = event.result;
            isError = result.isError ?? false;
            if (result.content) {
              for (const item of result.content) {
                if (item.type === 'text' && item.text) {
                  texts.push(item.text);
                } else if (item.type === 'image' && item.data && item.mimeType) {
                  const base64 = Buffer.from(item.data).toString('base64');
                  images.push({ data: base64, mimeType: item.mimeType });
                }
              }
            }
          }
        }
      }

      // executeCodeで画像が返されなかった場合、savefigで保存されたファイルをreadFilesで取得。
      // plt.show()ではtype:'image'のContentBlockは返されない。savefig()で相対パスに保存後、
      // readFilesでresource.blobから取得する。絶対パスは'path traversal detected'で拒否される。
      if (images.length === 0 && !isError) {
        const savefigMatch = input.code.match(/savefig\s*\(\s*['"]([^'"]+)['"]/);
        if (savefigMatch) {
          const filePath = savefigMatch[1];
          try {
            const readResponse = await client.send(
              new InvokeCodeInterpreterCommand({
                codeInterpreterIdentifier: CODE_INTERPRETER_ID,
                sessionId,
                name: 'readFiles',
                arguments: { paths: [filePath] },
              }),
            );
            if (readResponse.stream) {
              for await (const event of readResponse.stream) {
                if ('result' in event && event.result?.content) {
                  for (const item of event.result.content) {
                    if (item.data && item.mimeType) {
                      const base64 = Buffer.from(item.data).toString('base64');
                      images.push({ data: base64, mimeType: item.mimeType });
                    } else if (item.resource?.blob && item.resource?.mimeType) {
                      const base64 = Buffer.from(item.resource.blob).toString('base64');
                      images.push({ data: base64, mimeType: item.resource.mimeType });
                    }
                  }
                }
              }
            }
          } catch (err) {
            console.warn('[CodeInterpreter] readFiles failed:', err);
          }
        }
      }

      if (!texts.length && !images.length) return 'コード実行結果なし';

      if (isError) {
        return `コード実行エラー:\n${texts.join('\n')}`;
      }

      // 画像がある場合、外部バッファに蓄積（SSEハンドラーがストリーム完了後に送信）
      const textOutput = texts.join('\n') || '(出力なし)';
      if (images.length > 0) {
        imageBuffer.push(...images);
      }

      return textOutput;
    },
  });
}

/** セッションのクリーンアップ（ベストエフォート） */
export async function stopSession(conversationSessionId: string): Promise<void> {
  const sessionId = sessionMap.get(conversationSessionId);
  if (!sessionId) return;

  try {
    await client.send(
      new StopCodeInterpreterSessionCommand({
        codeInterpreterIdentifier: CODE_INTERPRETER_ID,
        sessionId,
      }),
    );
  } catch (err) {
    console.warn('[CodeInterpreter] stopSession failed:', err);
  } finally {
    sessionMap.delete(conversationSessionId);
  }
}
