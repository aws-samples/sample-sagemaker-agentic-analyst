import { getSession } from '@/lib/auth';
import { db } from '@agentic-analyst/db/client';
import { sessions } from '@agentic-analyst/db/schema';
import { eq, desc, and } from 'drizzle-orm';
import { BedrockAgentCoreClient, DeleteEventCommand, paginateListEvents } from '@aws-sdk/client-bedrock-agentcore';
import { env } from '@/lib/env';

export async function GET() {
  let session;
  try {
    session = await getSession();
  } catch {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const rows = await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, session.userId))
      .orderBy(desc(sessions.updatedAt));
    return Response.json(rows);
  } catch (error) {
    console.error('Failed to list sessions:', error);
    return Response.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  let session;
  try {
    session = await getSession();
  } catch {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) {
      return Response.json({ error: 'sessionId is required' }, { status: 400 });
    }

    // DSQL から削除
    try {
      await db.delete(sessions).where(and(eq(sessions.sessionId, sessionId), eq(sessions.userId, session.userId)));
    } catch (error) {
      console.warn('DSQL delete failed:', error);
    }

    // AgentCore Memory から削除（バックグラウンド — レスポンスをブロックしない）
    if (env.AGENTCORE_MEMORY_ID) {
      const memoryId = env.AGENTCORE_MEMORY_ID;
      const actorId = session.userId;
      void (async () => {
        try {
          const client = new BedrockAgentCoreClient({ region: env.AWS_REGION });
          const paginator = paginateListEvents(
            { client },
            { memoryId, actorId, sessionId, includePayloads: false, maxResults: 100 },
          );
          const eventIds: string[] = [];
          for await (const page of paginator) {
            for (const event of page.events || []) {
              if (event.eventId) eventIds.push(event.eventId);
            }
          }
          await Promise.allSettled(
            eventIds.map((eventId) => client.send(new DeleteEventCommand({ memoryId, actorId, sessionId, eventId }))),
          );
        } catch (error) {
          console.warn('Memory delete failed:', error);
        }
      })();
    }

    return Response.json({ success: true });
  } catch (error) {
    console.error('Failed to delete session:', error);
    return Response.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
