import { Agent, BedrockModel, McpClient, Message } from '@strands-agents/sdk';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import express from 'express';
import cors from 'cors';
import { createCodeInterpreterTool, type CodeInterpreterImage } from './code-interpreter-tool.js';
import type {
  ThinkingEvent,
  ToolStartEvent,
  StopEvent,
  ImageEvent,
  TitleUpdateEvent,
  DoneSignal,
} from '@agentic-analyst/shared-types';
import { env } from './env.js';
import { SSOOIDCClient, CreateTokenWithIAMCommand } from '@aws-sdk/client-sso-oidc';
import { SYSTEM_PROMPT } from './prompt.js';
import { SessionPersistenceHook } from './session/session-persistence-hook.js';

function createBearerFetch(jwtToken: string, customProjectId?: string, idcAccessToken?: string) {
  // RuntimeのrequestHeaderAllowlistのヘッダーはagentコードに伝播されるが、
  // Gateway呼び出しには自動転送されない。明示的にヘッダーを含める必要がある
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return fetch(url, {
      method: init?.method || 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${jwtToken}`,
        ...(customProjectId ? { 'x-sagemaker-project-id': customProjectId } : {}),
        ...(idcAccessToken ? { 'x-idc-access-token': idcAccessToken } : {}),
      },
      body: init?.body,
    });
  };
}

async function createMcpClient(
  jwtToken: string,
  customProjectId?: string,
  idcAccessToken?: string,
): Promise<McpClient> {
  const bearerFetch = createBearerFetch(jwtToken, customProjectId, idcAccessToken);
  return new McpClient({
    transport: new StreamableHTTPClientTransport(new URL(env.AGENTCORE_GATEWAY_URL), {
      fetch: bearerFetch,
    }) as Transport,
  });
}

/** JWT の payload から sub クレームを抽出（署名検証は Runtime が実施済み） */
function extractSubFromJwt(jwt: string): string {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
    return payload.sub || '';
  } catch {
    return '';
  }
}

const app = express();
app.use(cors());

app.get('/ping', (_, res) =>
  res.json({
    status: 'Healthy',
    time_of_last_update: Math.floor(Date.now() / 1000),
  }),
);

app.post(['/invocations', /^\/runtimes\/.+\/invocations$/], express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const payload = JSON.parse(new TextDecoder().decode(req.body));
    const prompt = payload.prompt || '';
    const customProjectId = req.headers['x-amzn-bedrock-agentcore-runtime-custom-sagemaker-project-id'] as
      | string
      | undefined;
    const idToken = req.headers['x-amzn-bedrock-agentcore-runtime-custom-cognito-id-token'] as string | undefined;
    const conversationSessionId = req.headers['x-amzn-bedrock-agentcore-runtime-session-id'] as string | undefined;

    const authHeader = req.headers['authorization'];
    const jwtToken = authHeader?.replace('Bearer ', '') || '';
    if (!jwtToken) {
      return res.status(401).json({ error: 'Authorization header is missing' });
    }

    const actorId = extractSubFromJwt(jwtToken);
    const sessionId = conversationSessionId || '';

    const imageBuffer: CodeInterpreterImage[] = [];

    // SessionPersistenceHook の設定
    let hook: SessionPersistenceHook | undefined;
    let history: Message[] = [];

    if (env.AGENTCORE_MEMORY_ID && sessionId) {
      hook = new SessionPersistenceHook({
        memoryId: env.AGENTCORE_MEMORY_ID,
        region: env.AWS_REGION,
        sessionConfig: { actorId, sessionId },
        conversationWindowSize: env.CONVERSATION_WINDOW_SIZE,
        dsqlEndpoint: env.DSQL_ENDPOINT,
        titleModelId: env.TITLE_MODEL_ID,
      });
      history = await hook.loadHistory();
    }

    // Agent 作成
    const model = new BedrockModel({
      region: env.AWS_REGION,
      modelId: env.BEDROCK_MODEL_ID,
      maxTokens: 8192,
      additionalRequestFields: {
        thinking: { type: 'enabled', budget_tokens: 2048 },
      },
    });

    const codeInterpreterTool = conversationSessionId
      ? createCodeInterpreterTool(conversationSessionId, imageBuffer)
      : undefined;

    let tools: (McpClient | ReturnType<typeof createCodeInterpreterTool>)[] = [];
    if (env.AGENTCORE_GATEWAY_URL) {
      // CreateTokenWithIAM: jtiを消費する唯一の操作。1リクエストで1回だけ実行し、
      // 得られたIdC Access Tokenを全Tool Lambdaにヘッダーで伝播する。
      let idcAccessToken: string | undefined;
      if (idToken && env.IDC_APPLICATION_ARN) {
        try {
          const tokenRes = await new SSOOIDCClient({ region: env.AWS_REGION }).send(
            new CreateTokenWithIAMCommand({
              clientId: env.IDC_APPLICATION_ARN,
              grantType: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
              assertion: idToken,
            }),
          );
          idcAccessToken = tokenRes.accessToken ?? undefined;
        } catch (e) {
          console.error('CreateTokenWithIAM failed:', e);
        }
      }
      const mcpClient = await createMcpClient(jwtToken, customProjectId, idcAccessToken);
      tools.push(mcpClient);
    }
    if (codeInterpreterTool) tools.push(codeInterpreterTool);

    const agent = new Agent({
      model,
      systemPrompt: SYSTEM_PROMPT,
      tools,
      hooks: hook ? [hook] : [],
    });

    // Memory から履歴を注入
    if (history.length > 0) {
      agent.messages.push(...history);
    }

    console.log(
      `[Request] prompt="${prompt.substring(0, 100)}", projectId=${customProjectId}, hasJwt=${!!jwtToken}, historyLen=${history.length}, sessionId=${sessionId}`,
    );

    const acceptHeader = req.headers['accept'] || '';
    if (acceptHeader.includes('text/event-stream')) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const streamGen = agent.stream(prompt);
      for await (const event of streamGen) {
        if (event.type === 'modelContentBlockDeltaEvent' && event.delta.type === 'textDelta' && event.delta.text) {
          res.write(`data: ${JSON.stringify(event.delta.text)}\n\n`);
        } else if (
          event.type === 'modelContentBlockDeltaEvent' &&
          event.delta.type === 'reasoningContentDelta' &&
          event.delta.text
        ) {
          res.write(
            `data: ${JSON.stringify({ type: 'thinking', text: event.delta.text } satisfies ThinkingEvent)}\n\n`,
          );
        } else if (event.type === 'beforeToolCallEvent') {
          console.log(`🔧 Tool #${event.toolUse.name}`, JSON.stringify(event.toolUse.input).substring(0, 500));
          res.write(
            `data: ${JSON.stringify({ type: 'tool_start', name: event.toolUse.name } satisfies ToolStartEvent)}\n\n`,
          );
        } else if (event.type === 'afterToolCallEvent') {
          const resultStr = JSON.stringify(event.result).substring(0, 500);
          console.log(`✓ Tool completed: ${resultStr}`);
        } else if (event.type === 'modelMessageStopEvent') {
          res.write(`data: ${JSON.stringify({ type: 'stop', stopReason: event.stopReason } satisfies StopEvent)}\n\n`);
        }
      }
      for (const img of imageBuffer) {
        res.write(
          `data: ${JSON.stringify({ type: 'image', data: img.data, mimeType: img.mimeType } satisfies ImageEvent)}\n\n`,
        );
      }
      // 画像を AgentCore Memory に保存（Strands messages には含まれないため手動保存）
      // webapp の /api/sessions/[sessionId]/events が blob から imageBlock を読み取り表示する
      if (hook && imageBuffer.length > 0) {
        try {
          const imgContent = imageBuffer.map((img) => ({
            type: 'imageBlock' as const,
            format: (img.mimeType.split('/')[1] || 'png') as 'png' | 'jpeg' | 'gif' | 'webp',
            base64: img.data,
          }));
          const imgMessage = new Message({ role: 'assistant', content: imgContent as never[] });
          await hook.appendMessage(imgMessage);
        } catch (e) {
          console.warn('Failed to save images to Memory:', e);
        }
      }
      // タイトル生成: 初回メッセージ時にSSEイベントとしてプッシュ
      if (hook && history.length === 0 && prompt) {
        try {
          const title = await hook.generateTitle(prompt);
          const evt: TitleUpdateEvent = { type: 'title_update', title };
          res.write(`data: ${JSON.stringify(evt)}\n\n`);
        } catch (e) {
          console.warn('Failed to generate title for SSE:', e);
        }
      }
      res.write(`data: ${'[DONE]' satisfies DoneSignal}\n\n`);
      res.end();
    } else {
      const response = await agent.invoke(prompt);
      console.log(`[Response] ${JSON.stringify(response).substring(0, 500)}`);
      return res.json({ response });
    }
  } catch (err) {
    console.error('Error processing request:', err);
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: 'Internal server error' })}\n\n`);
      res.end();
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

app.listen(env.PORT, () => {
  console.log(`AgentCore Runtime server listening on port ${env.PORT}`);
  console.log(`Gateway URL: ${env.AGENTCORE_GATEWAY_URL || '(not configured)'}`);
  console.log(`Memory ID: ${env.AGENTCORE_MEMORY_ID || '(not configured)'}`);
});
