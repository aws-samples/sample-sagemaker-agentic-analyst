/**
 * AgentCore Memory への CRUD 操作
 */
import {
  BedrockAgentCoreClient,
  CreateEventCommand,
  DeleteEventCommand,
  paginateListEvents,
  type PayloadType,
} from '@aws-sdk/client-bedrock-agentcore';
import { type Message } from '@strands-agents/sdk';
import { messageToPayload, payloadToMessage, type AgentCorePayload } from './converters.js';

export interface SessionConfig {
  actorId: string;
  sessionId: string;
}

export class AgentCoreMemoryStorage {
  private client: BedrockAgentCoreClient;

  constructor(
    private readonly memoryId: string,
    region: string,
  ) {
    this.client = new BedrockAgentCoreClient({ region });
  }

  async loadMessages(config: SessionConfig, windowSize?: number): Promise<Message[]> {
    const allEvents = [];
    const paginator = paginateListEvents(
      { client: this.client },
      {
        memoryId: this.memoryId,
        actorId: config.actorId,
        sessionId: config.sessionId,
        includePayloads: true,
        maxResults: 100,
      },
    );

    for await (const page of paginator) {
      if (page.events) allEvents.push(...page.events);
    }

    if (allEvents.length === 0) return [];

    // 時系列順にソート
    allEvents.sort((a, b) => {
      const tA = a.eventTimestamp ? new Date(a.eventTimestamp).getTime() : 0;
      const tB = b.eventTimestamp ? new Date(b.eventTimestamp).getTime() : 0;
      return tA - tB;
    });

    const messages: Message[] = [];
    for (const event of allEvents) {
      if (event.payload && event.payload.length > 0) {
        const payload = event.payload[0] as AgentCorePayload;
        const msg = payloadToMessage(payload);
        if (msg) messages.push(msg);
      }
    }

    // ウィンドウサイズで制限
    if (windowSize && messages.length > windowSize) {
      return messages.slice(-windowSize);
    }
    return messages;
  }

  async appendMessage(config: SessionConfig, message: Message): Promise<void> {
    const payload = messageToPayload(message);
    if (!payload) return;
    await this.client.send(
      new CreateEventCommand({
        memoryId: this.memoryId,
        actorId: config.actorId,
        sessionId: config.sessionId,
        eventTimestamp: new Date(),
        payload: [payload as PayloadType],
      }),
    );
  }

  async deleteSession(config: SessionConfig): Promise<void> {
    const allEvents = [];
    const paginator = paginateListEvents(
      { client: this.client },
      {
        memoryId: this.memoryId,
        actorId: config.actorId,
        sessionId: config.sessionId,
        includePayloads: false,
        maxResults: 100,
      },
    );

    for await (const page of paginator) {
      if (page.events) allEvents.push(...page.events);
    }

    for (const event of allEvents) {
      if (event.eventId) {
        await this.client.send(
          new DeleteEventCommand({
            memoryId: this.memoryId,
            actorId: config.actorId,
            sessionId: config.sessionId,
            eventId: event.eventId,
          }),
        );
      }
    }
  }
}
