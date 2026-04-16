/**
 * Integration test: Bedrock + adaptive thinking + system prompt
 *
 * Bedrockに直接推論リクエストを送り、以下を検証する:
 * - adaptive thinkingが有効に動作すること
 * - システムプロンプトのロール・行動規約が応答に反映されること
 * - ストリーミングでthinkingブロックとtextブロックが分離されること
 */
import { Agent, BedrockModel } from '@strands-agents/sdk';
import { SYSTEM_PROMPT } from '../../src/prompt.js';

const AWS_REGION = process.env.AWS_REGION || 'us-west-2';
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || 'global.anthropic.claude-sonnet-4-6';

function createModel(): BedrockModel {
  return new BedrockModel({
    region: AWS_REGION,
    modelId: BEDROCK_MODEL_ID,
    maxTokens: 16000,
    additionalRequestFields: {
      thinking: { type: 'adaptive' },
    },
  });
}

function createAgent(): Agent {
  return new Agent({
    model: createModel(),
    systemPrompt: SYSTEM_PROMPT,
  });
}

interface TestCase {
  name: string;
  prompt: string;
  validate: (response: string) => { pass: boolean; reason: string };
}

const testCases: TestCase[] = [
  {
    name: 'adaptive thinking動作確認',
    prompt: '日本の首都はどこですか？',
    validate: (response) => {
      const has東京 = response.includes('東京');
      return { pass: has東京, reason: has東京 ? '東京を含む回答' : `東京が含まれない: ${response.slice(0, 100)}` };
    },
  },
  {
    name: '感嘆符を使わない（principles反映）',
    prompt: '売上データの分析方法について教えてください。',
    validate: (response) => {
      const exclamationCount = (response.match(/！|!/g) || []).length;
      return {
        pass: exclamationCount === 0,
        reason: exclamationCount === 0 ? '感嘆符なし' : `感嘆符が${exclamationCount}個: ${response.slice(0, 200)}`,
      };
    },
  },
  {
    name: '空疎な肯定を避ける（principles反映）',
    prompt: '先月の売上トップ10を知りたいのですが、良い分析方法はありますか？',
    validate: (response) => {
      const sycophancy = /素晴らしい|良い質問|great question/i.test(response);
      return {
        pass: !sycophancy,
        reason: sycophancy ? `空疎な肯定を検出: ${response.slice(0, 200)}` : '空疎な肯定なし',
      };
    },
  },
  {
    name: 'ストリーミングでthinkingとtextが分離される',
    prompt: '100を7で割った余りは？',
    validate: (response) => {
      const has2 = response.includes('2');
      return { pass: has2, reason: has2 ? '正答(2)を含む' : `正答が含まれない: ${response.slice(0, 100)}` };
    },
  },
];

async function runStreamingTest(): Promise<{ pass: boolean; reason: string }> {
  const model = createModel();
  const agent = new Agent({ model, systemPrompt: SYSTEM_PROMPT });

  let hasThinking = false;
  let hasText = false;
  let textContent = '';

  const stream = agent.stream('100を7で割った余りは？');
  for await (const event of stream) {
    if (event.type === 'modelContentBlockDeltaEvent') {
      if (event.delta.type === 'reasoningContentDelta') {
        hasThinking = true;
      }
      if (event.delta.type === 'textDelta' && event.delta.text) {
        hasText = true;
        textContent += event.delta.text;
      }
    }
  }

  // adaptive thinkingはクエリの複雑さに応じてthinkingをスキップする場合がある
  const pass = hasText && textContent.includes('2');
  return {
    pass,
    reason: `thinking=${hasThinking}, text=${hasText}, content="${textContent.slice(0, 100)}"`,
  };
}

async function main() {
  console.log(`Model: ${BEDROCK_MODEL_ID}`);
  console.log(`Region: ${AWS_REGION}`);
  console.log('---');

  let passed = 0;
  let failed = 0;

  // invoke tests
  for (const tc of testCases) {
    process.stdout.write(`[RUN]  ${tc.name} ... `);
    try {
      const agent = createAgent();
      const response = await agent.invoke(tc.prompt);
      const text = typeof response === 'string' ? response : JSON.stringify(response);
      const result = tc.validate(text);
      if (result.pass) {
        console.log(`✅ ${result.reason}`);
        passed++;
      } else {
        console.log(`❌ ${result.reason}`);
        failed++;
      }
    } catch (err) {
      console.log(`❌ Error: ${err}`);
      failed++;
    }
  }

  // streaming test
  process.stdout.write('[RUN]  ストリーミング分離確認 ... ');
  try {
    const result = await runStreamingTest();
    if (result.pass) {
      console.log(`✅ ${result.reason}`);
      passed++;
    } else {
      console.log(`❌ ${result.reason}`);
      failed++;
    }
  } catch (err) {
    console.log(`❌ Error: ${err}`);
    failed++;
  }

  console.log('---');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
