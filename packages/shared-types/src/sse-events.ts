/**
 * agents/chat ↔ webapp 間のSSEイベント型定義
 *
 * chat-agentがSSEストリームで送信し、webappのChatInterfaceがパースする。
 */

/** LLMの思考過程 */
export interface ThinkingEvent {
  type: 'thinking';
  text: string;
}

/** ツール呼び出し開始 */
export interface ToolStartEvent {
  type: 'tool_start';
  name: string;
}

/** モデルメッセージ停止 */
export interface StopEvent {
  type: 'stop';
  stopReason: string;
}

/** Code Interpreterで生成された画像 */
export interface ImageEvent {
  type: 'image';
  data: string;
  mimeType: string;
}

/** タイトル更新（ストリーム完了後に送信） */
export interface TitleUpdateEvent {
  type: 'title_update';
  title: string;
}

/** 会話履歴（ストリーム完了後に送信） */
export interface MessagesEvent {
  messages: Array<{ role: string; content: unknown }>;
}

/** ストリーム終了シグナル */
export type DoneSignal = '[DONE]';

/** SSEイベントの判別用ユニオン型 */
export type SSEEvent = ThinkingEvent | ToolStartEvent | StopEvent | ImageEvent | TitleUpdateEvent;
