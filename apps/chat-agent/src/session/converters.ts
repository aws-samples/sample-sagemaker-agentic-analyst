/**
 * Strands Message ↔ AgentCore Memory Payload 変換
 */
import { Message, TextBlock, type ContentBlock } from '@strands-agents/sdk';

export interface ConversationalPayload {
  conversational: { content: { text: string }; role: 'USER' | 'ASSISTANT' };
}

export interface BlobPayload {
  blob: Uint8Array;
}

export type AgentCorePayload = ConversationalPayload | BlobPayload;

interface BlobData {
  messageType: 'content';
  role: string;
  content: ContentBlock[];
}

/**
 * Strands Message → AgentCore Payload
 */
export function messageToPayload(message: Message): AgentCorePayload | null {
  if (!message.content || message.content.length === 0) {
    return null;
  }

  // テキストのみの単一ブロック → conversational
  const hasNonText = message.content.some((b) => b.type !== 'textBlock');
  if (!hasNonText && message.content.length === 1) {
    const block = message.content[0];
    if (block.type === 'textBlock' && 'text' in block) {
      return {
        conversational: {
          content: { text: block.text },
          role: message.role === 'user' ? 'USER' : 'ASSISTANT',
        },
      };
    }
  }

  // 複雑なメッセージ → blob
  const blobData: BlobData = {
    messageType: 'content',
    role: message.role,
    content: message.content,
  };
  return { blob: new TextEncoder().encode(JSON.stringify(blobData)) };
}

/**
 * AgentCore Payload → Strands Message
 *
 * テキストを含まないメッセージ（toolUseBlock のみ、toolResultBlock のみ等）は
 * null を返す。Bedrock Converse API は空テキストの ContentBlock を拒否するため。
 */
export function payloadToMessage(payload: AgentCorePayload): Message | null {
  if ('conversational' in payload) {
    const text = payload.conversational.content.text;
    if (!text || !text.trim()) return null;
    const role = payload.conversational.role === 'USER' ? 'user' : 'assistant';
    return new Message({ role, content: [new TextBlock(text)] });
  }

  if ('blob' in payload && payload.blob) {
    try {
      let raw: string;
      if (payload.blob instanceof Uint8Array) {
        raw = new TextDecoder().decode(payload.blob);
      } else if (typeof payload.blob === 'string') {
        try {
          raw = Buffer.from(payload.blob, 'base64').toString('utf8');
        } catch {
          raw = payload.blob;
        }
      } else {
        raw = JSON.stringify(payload.blob);
      }

      const data = JSON.parse(raw) as BlobData;
      if (data.messageType === 'content') {
        // toolUseBlock / toolResultBlock / imageBlock は Strands SDK の
        // BedrockModel._formatContentBlock で TypeError になるためテキストのみ復元
        const textOnly = (data.content || []).filter(
          (b): b is ContentBlock =>
            b != null && typeof b === 'object' && 'type' in b && b.type === 'textBlock' && 'text' in b && !!b.text,
        );
        if (textOnly.length === 0) return null;
        return new Message({ role: data.role as 'user' | 'assistant', content: textOnly });
      }
    } catch (e) {
      console.warn('[payloadToMessage] blob parse failed:', e);
    }
  }

  return null;
}
