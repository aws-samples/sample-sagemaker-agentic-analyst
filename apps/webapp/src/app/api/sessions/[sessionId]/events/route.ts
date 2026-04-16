import { getSession } from '@/lib/auth';
import { BedrockAgentCoreClient, paginateListEvents } from '@aws-sdk/client-bedrock-agentcore';
import { env } from '@/lib/env';
import { type NextRequest } from 'next/server';

interface ConversationalPayload {
  conversational: { content: { text: string }; role: 'USER' | 'ASSISTANT' };
}

interface BlobPayload {
  blob: Uint8Array;
}

type AgentCorePayload = ConversationalPayload | BlobPayload;

interface MessageContent {
  role: 'user' | 'assistant';
  content: { type: string; text?: string; [key: string]: unknown }[];
  timestamp?: string;
}

function payloadToMessage(payload: AgentCorePayload, timestamp?: Date): MessageContent {
  if ('conversational' in payload) {
    return {
      role: payload.conversational.role === 'USER' ? 'user' : 'assistant',
      content: [{ type: 'text', text: payload.conversational.content.text }],
      timestamp: timestamp?.toISOString(),
    };
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
      const data = JSON.parse(raw) as { messageType: string; role: string; content: unknown[] };
      if (data.messageType === 'content') {
        return {
          role: data.role as 'user' | 'assistant',
          content: data.content as MessageContent['content'],
          timestamp: timestamp?.toISOString(),
        };
      }
    } catch {
      // フォールバック
    }
  }

  return { role: 'assistant', content: [{ type: 'text', text: '' }], timestamp: timestamp?.toISOString() };
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  let session;
  try {
    session = await getSession();
  } catch {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { sessionId } = await params;

    if (!env.AGENTCORE_MEMORY_ID) {
      return Response.json({ error: 'Memory not configured' }, { status: 500 });
    }

    const client = new BedrockAgentCoreClient({ region: env.AWS_REGION });
    const allEvents = [];
    const paginator = paginateListEvents(
      { client },
      {
        memoryId: env.AGENTCORE_MEMORY_ID,
        actorId: session.userId,
        sessionId,
        includePayloads: true,
        maxResults: 100,
      },
    );

    for await (const page of paginator) {
      if (page.events) allEvents.push(...page.events);
    }

    if (allEvents.length === 0) {
      return Response.json([]);
    }

    // 時系列順にソート
    allEvents.sort((a, b) => {
      const tA = a.eventTimestamp ? new Date(a.eventTimestamp).getTime() : 0;
      const tB = b.eventTimestamp ? new Date(b.eventTimestamp).getTime() : 0;
      return tA - tB;
    });

    const messages: MessageContent[] = [];
    for (const event of allEvents) {
      if (event.payload && event.payload.length > 0) {
        const payload = event.payload[0] as unknown as AgentCorePayload;
        messages.push(payloadToMessage(payload, event.eventTimestamp));
      }
    }

    return Response.json(messages);
  } catch (error) {
    console.error('Failed to list events:', error);
    return Response.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
