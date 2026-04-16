/**
 * SessionPersistenceHook — Strands HookProvider
 *
 * - MessageAddedEvent: リアルタイムで AgentCore Memory に保存
 * - AfterInvocationEvent: フォールバック保存
 * - DSQL: セッションメタデータ（作成・更新）— AuroraDSQLPool で直接操作
 */
import {
  type HookProvider,
  type HookRegistry,
  type AfterInvocationEvent,
  MessageAddedEvent,
  type Message,
} from '@strands-agents/sdk';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { AgentCoreMemoryStorage, type SessionConfig } from './agentcore-memory-storage.js';
import { AuroraDSQLPool } from '@aws/aurora-dsql-node-postgres-connector';

export interface SessionPersistenceHookOptions {
  memoryId: string;
  region: string;
  sessionConfig: SessionConfig;
  conversationWindowSize?: number;
  dsqlEndpoint?: string;
  /** タイトル生成に使用するBedrockモデルID（Haiku推奨） */
  titleModelId?: string;
}

// シングルトン（Lambda コンテナ再利用対応）
let bedrockClient: BedrockRuntimeClient | undefined;
function getBedrockClient(region: string): BedrockRuntimeClient {
  if (!bedrockClient) {
    bedrockClient = new BedrockRuntimeClient({ region });
  }
  return bedrockClient;
}

let dsqlPool: AuroraDSQLPool | undefined;
function getDsqlPool(endpoint: string, region: string): AuroraDSQLPool {
  if (!dsqlPool) {
    dsqlPool = new AuroraDSQLPool({ host: endpoint, region, user: 'admin', database: 'postgres', port: 5432 });
  }
  return dsqlPool;
}

async function dsqlQuery(endpoint: string, region: string, sql: string, params: unknown[] = []) {
  const pool = getDsqlPool(endpoint, region);
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

// chat-agent は @agentic-analyst/db（Drizzle ORM）に依存しない。
// 理由: chat-agent の Docker イメージに packages/db を含めると、pg ネイティブバインディングの
// ビルド依存が増加し、イメージサイズが肥大化する。セッションメタデータの操作は
// INSERT/UPDATE のみで ORM の恩恵が薄いため、AuroraDSQLPool で直接 SQL を実行する。
export class SessionPersistenceHook implements HookProvider {
  private storage: AgentCoreMemoryStorage;
  private config: SessionConfig;
  private isFirstUserMessage = true;
  private userMessageCount = 0;
  private savedCount = 0;

  constructor(private readonly options: SessionPersistenceHookOptions) {
    this.storage = new AgentCoreMemoryStorage(options.memoryId, options.region);
    this.config = options.sessionConfig;
  }

  async loadHistory(): Promise<Message[]> {
    const messages = await this.storage.loadMessages(this.config, this.options.conversationWindowSize);
    this.savedCount = messages.length;
    // 既存セッション再開時: 履歴のユーザーメッセージ数を反映
    this.userMessageCount = messages.filter((m) => m.role === 'user').length;
    if (this.userMessageCount > 0) this.isFirstUserMessage = false;
    return messages;
  }

  async appendMessage(message: Message): Promise<void> {
    await this.storage.appendMessage(this.config, message);
    this.savedCount++;
  }

  registerCallbacks(registry: HookRegistry): void {
    registry.addCallback(MessageAddedEvent, (event) => this.onMessageAdded(event));
    // AfterInvocationEvent は使用しない — stream() での発火タイミングが不定のため
    // 手動保存を index.ts で実行する
  }

  private async onMessageAdded(event: MessageAddedEvent): Promise<void> {
    const message = event.message;

    // リアルタイム保存（user + assistant 両方）
    try {
      await this.storage.appendMessage(this.config, message);
      this.savedCount++;
    } catch (error) {
      console.warn('[SessionPersistenceHook] リアルタイム保存失敗:', error);
    }

    // DSQL セッションメタデータ管理
    if (!this.options.dsqlEndpoint) return;
    if (message.role !== 'user') return;

    this.userMessageCount++;

    if (this.isFirstUserMessage) {
      this.isFirstUserMessage = false;
      const title = extractTitle(message);

      try {
        await dsqlQuery(
          this.options.dsqlEndpoint,
          this.options.region,
          `INSERT INTO sessions (id, "userId", "sessionId", title, "createdAt", "updatedAt")
           VALUES (gen_random_uuid(), $1, $2, $3, now(), now())
           ON CONFLICT ("sessionId") DO UPDATE SET "updatedAt" = now()`,
          [this.config.actorId, this.config.sessionId, title],
        );
      } catch (error) {
        console.warn('[SessionPersistenceHook] DSQL操作失敗:', error);
      }
    } else {
      try {
        await dsqlQuery(
          this.options.dsqlEndpoint,
          this.options.region,
          'UPDATE sessions SET "updatedAt" = now() WHERE "sessionId" = $1',
          [this.config.sessionId],
        );
      } catch {
        // ベストエフォート
      }
    }

    // タイトル生成: 5n+1回目（1, 6, 11, ...）のユーザーメッセージで実行
    if ((this.userMessageCount - 1) % 5 === 0) {
      const userText = extractText(message);
      if (userText) {
        void this.generateTitleAsync(userText);
      }
    }
  }

  private async onAfterInvocation(event: AfterInvocationEvent): Promise<void> {
    const totalMessages = event.agent.messages.length;
    if (this.savedCount < totalMessages) {
      const unsaved = event.agent.messages.slice(this.savedCount);
      for (const msg of unsaved) {
        try {
          await this.storage.appendMessage(this.config, msg);
          this.savedCount++;
        } catch (error) {
          console.warn('[SessionPersistenceHook] フォールバック保存失敗:', error);
        }
      }
    }
  }

  private async generateTitleAsync(userText: string): Promise<void> {
    if (!this.options.dsqlEndpoint) return;
    try {
      const title = await this.generateTitle(userText);

      await dsqlQuery(
        this.options.dsqlEndpoint,
        this.options.region,
        'UPDATE sessions SET title = $1, "updatedAt" = now() WHERE "sessionId" = $2',
        [title, this.config.sessionId],
      );
    } catch (error) {
      console.warn('[SessionPersistenceHook] タイトル生成失敗:', error);
    }
  }

  async generateTitle(userText: string): Promise<string> {
    const fallback = userText.length > 50 ? `${userText.substring(0, 50)}...` : userText;
    if (!this.options.titleModelId) return fallback;

    // 全ユーザーメッセージを収集（agent.messagesにアクセスできないため、Memoryから取得済みの履歴 + 現在のメッセージを使う）
    const truncatedUser = userText.slice(0, 500);

    const client = getBedrockClient(this.options.region);
    const response = await client.send(
      new ConverseCommand({
        modelId: this.options.titleModelId,
        system: [
          {
            text: `会話のタイトルを日本語で生成してください。
ルール:
- 会話の主題を表す名詞句（体言止め）にする
- 10〜20文字を目標（最大40文字）
- タイトルのみを出力する。括弧や引用符で囲まない
- 「〜について」「〜の質問」のような冗長な表現は避ける
- ユーザーの意図・目的を反映する（手段ではなく目的）`,
          },
        ],
        messages: [
          {
            role: 'user',
            content: [{ text: truncatedUser }],
          },
        ],
        inferenceConfig: { maxTokens: 60, temperature: 0 },
      }),
    );

    const text =
      response.output?.message?.content
        ?.map((b) => b.text)
        .filter(Boolean)
        .join('') ?? '';
    return text.trim().slice(0, 40) || fallback;
  }
}

function extractTitle(message: Message): string {
  const text = extractText(message);
  if (!text) return 'New Chat';
  return text.length > 50 ? `${text.substring(0, 50)}...` : text;
}

function extractText(message: Message): string {
  for (const block of message.content || []) {
    if (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string') {
      return block.text.trim();
    }
  }
  return '';
}
