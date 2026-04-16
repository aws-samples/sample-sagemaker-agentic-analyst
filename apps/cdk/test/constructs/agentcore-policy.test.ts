import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { Gateway, GatewayAuthorizer } from '@aws-cdk/aws-bedrock-agentcore-alpha';
import { UserPool, UserPoolClient } from 'aws-cdk-lib/aws-cognito';
import { PolicyEngine, generateCedarStatement } from '../../lib/constructs/agentcore-policy';

// --- cedar.ts 単体テスト ---

describe('generateCedarStatement', () => {
  const gatewayArn = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/gw-12345';

  test('ツール1個の場合', () => {
    const result = generateCedarStatement(gatewayArn, 'admins', ['tool___action']);
    expect(result).toContain('like "*|admins|*"');
    expect(result).toContain('action == AgentCore::Action::"tool___action"');
    expect(result).toContain(`resource == AgentCore::Gateway::"${gatewayArn}"`);
    // OR演算子が含まれないこと
    expect(result).not.toContain('||');
  });

  test('ツール複数個の場合', () => {
    const result = generateCedarStatement(gatewayArn, 'data-producers', [
      'data-access___athena_query',
      'data-access___s3_read',
      'data-access___s3_list',
    ]);
    expect(result).toContain('like "*|data-producers|*"');
    expect(result).toContain('action == AgentCore::Action::"data-access___athena_query"');
    expect(result).toContain('action == AgentCore::Action::"data-access___s3_read"');
    expect(result).toContain('action == AgentCore::Action::"data-access___s3_list"');
    // OR演算子で結合されること
    expect(result).toContain('||');
  });

  test('permit文の構造が正しいこと', () => {
    const result = generateCedarStatement(gatewayArn, 'group', ['t___a']);
    expect(result).toContain('permit(');
    expect(result).toMatch(/;\s*$/);
    expect(result).toContain('principal is AgentCore::OAuthUser');
    expect(result).toContain('principal.hasTag("cedar_groups")');
    expect(result).toContain('principal.getTag("cedar_groups")');
  });
});

// --- policy-engine.ts CDK assertions ---

function createTestStack(): { stack: cdk.Stack; gateway: Gateway } {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-west-2' },
  });
  const userPool = new UserPool(stack, 'Pool');
  const client = new UserPoolClient(stack, 'Client', { userPool });
  const gateway = new Gateway(stack, 'Gateway', {
    gatewayName: 'test-gateway',
    authorizerConfiguration: GatewayAuthorizer.usingCognito({
      userPool,
      allowedClients: [client],
    }),
  });
  return { stack, gateway };
}

describe('PolicyEngine construct', () => {
  test('Custom Resource に正しいポリシー定義が渡されること', () => {
    const { stack, gateway } = createTestStack();

    const pe = new PolicyEngine(stack, 'PE', { gateway });
    pe.addPolicy('TestPolicy', {
      group: 'test-group',
      tools: ['target___tool_a', 'target___tool_b'],
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudFormation::CustomResource', {
      policies: Match.arrayWith([Match.objectLike({ name: 'ed3d8c1f_TestPolicy' })]),
      policyEngineName: 'test_gateway_authz',
    });
  });

  test('addCedarPolicy で生のCedar文が渡されること', () => {
    const { stack, gateway } = createTestStack();

    const pe = new PolicyEngine(stack, 'PE', { gateway });
    pe.addCedarPolicy('RawPolicy', {
      statement: 'permit(principal, action, resource);',
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudFormation::CustomResource', {
      policies: Match.arrayWith([
        Match.objectLike({
          name: 'ed3d8c1f_RawPolicy',
          statement: 'permit(principal, action, resource);',
        }),
      ]),
    });
  });

  test('Lambda に正しい IAM 権限が付与されること', () => {
    const { stack, gateway } = createTestStack();

    const pe = new PolicyEngine(stack, 'PE', { gateway });
    pe.addPolicy('P', { group: 'g', tools: ['t___a'] });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['bedrock-agentcore:CreatePolicyEngine', 'bedrock-agentcore:DeletePolicyEngine']),
          }),
        ]),
      },
    });
  });
});

// --- バリデーションテスト ---

describe('PolicyEngine validation', () => {
  test('ポリシー名の重複で即座にエラーになること', () => {
    const { stack, gateway } = createTestStack();
    const pe = new PolicyEngine(stack, 'PE', { gateway });
    pe.addPolicy('Dup', { group: 'g', tools: ['t___a'] });

    expect(() => {
      pe.addPolicy('Dup', { group: 'g2', tools: ['t___b'] });
    }).toThrow(/既に追加されています/);
  });

  test('空の tools で即座にエラーになること', () => {
    const { stack, gateway } = createTestStack();
    const pe = new PolicyEngine(stack, 'PE', { gateway });

    expect(() => {
      pe.addPolicy('Empty', { group: 'g', tools: [] });
    }).toThrow(/空にできません/);
  });

  test('ポリシー未追加で synth 時にエラーになること', () => {
    const { stack, gateway } = createTestStack();
    new PolicyEngine(stack, 'PE', { gateway });

    expect(() => {
      Template.fromStack(stack);
    }).toThrow(/少なくとも1つのポリシー/);
  });
});
