import { type CfnResource, CustomResource, Duration, Lazy, Stack } from 'aws-cdk-lib';
import { Runtime, Architecture } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { Construct, type IValidation } from 'constructs';
import { type Gateway } from '@aws-cdk/aws-bedrock-agentcore-alpha';
import { join } from 'path';
import { createHash } from 'crypto';
import { generateCedarStatement } from './cedar';

export interface PolicyEngineProps {
  /** 関連付けるGateway */
  readonly gateway: Gateway;
  /** Policy Engine名。@default - Gatewayの名前から自動生成 */
  readonly policyEngineName?: string;
}

export interface GroupToolsPolicyOptions {
  /** Cognito グループ名（like "*|{group}|*" パターンで照合） */
  readonly group: string;
  /** 許可するツールアクション（"target___tool" 形式） */
  readonly tools: string[];
}

export interface CedarPolicyOptions {
  /** Cedar policy statement */
  readonly statement: string;
}

interface PolicyDefinition {
  name: string;
  statement: string;
}

/**
 * AgentCore Policy Engine コンストラクト
 *
 * Custom Resource + Provider Framework で L2 相当のコンストラクトを提供する。
 * addPolicy() / addCedarPolicy() で蓄積した定義を synth 時に Custom Resource properties に渡す。
 */
export class PolicyEngine extends Construct {
  /** Policy Engine ID（Custom Resource 作成後に解決される） */
  readonly policyEngineId: string;

  private readonly policies: PolicyDefinition[] = [];
  private readonly policyNames = new Set<string>();
  private readonly gateway: Gateway;
  private readonly resource: CustomResource;
  private readonly policyEngineName: string;
  private readonly policyNamePrefix: string;

  constructor(scope: Construct, id: string, props: PolicyEngineProps) {
    super(scope, id);

    this.gateway = props.gateway;
    this.policyEngineName = props.policyEngineName ?? props.gateway.name.replace(/[^A-Za-z0-9_]/g, '_') + '_authz';
    this.policyNamePrefix = createHash('sha256').update(this.policyEngineName).digest('hex').slice(0, 8);

    const logGroup = new LogGroup(this, 'Logs', { retention: RetentionDays.ONE_WEEK });

    const onEventHandler = new NodejsFunction(this, 'Handler', {
      entry: join(__dirname, 'handler.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.minutes(5),
      memorySize: 256,
      logGroup,
      bundling: { minify: true, sourceMap: true, externalModules: [] },
      depsLockFilePath: join(__dirname, '..', '..', '..', '..', '..', 'pnpm-lock.yaml'),
    });

    onEventHandler.addToRolePolicy(
      new PolicyStatement({
        actions: [
          'bedrock-agentcore:CreatePolicyEngine',
          'bedrock-agentcore:DeletePolicyEngine',
          'bedrock-agentcore:GetPolicyEngine',
          'bedrock-agentcore:ListPolicyEngines',
          'bedrock-agentcore:CreatePolicy',
          'bedrock-agentcore:UpdatePolicy',
          'bedrock-agentcore:GetPolicy',
          'bedrock-agentcore:DeletePolicy',
          'bedrock-agentcore:ListPolicies',
          'bedrock-agentcore:ManageResourceScopedPolicy',
          'bedrock-agentcore:ManageAdminPolicy',
          'bedrock-agentcore:UpdateGateway',
          'bedrock-agentcore:GetGateway',
        ],
        resources: ['*'],
      }),
    );

    onEventHandler.addToRolePolicy(
      new PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [props.gateway.role.roleArn],
      }),
    );

    const provider = new Provider(this, 'Provider', {
      onEventHandler,
      logGroup: new LogGroup(this, 'ProviderLogs', { retention: RetentionDays.ONE_WEEK }),
    });

    // Gateway L1のプロパティ変更を検知してCustom Resourceを再実行するため、
    // CfnGatewayのプロパティをハッシュ化して含める（Lambda currentVersion と同じ手法）。
    // CloudFormationがGatewayを更新するとpolicyEngineConfigurationが消えるため、
    // Custom Resourceで毎回再設定する必要がある。
    const cfnGateway = props.gateway.node.defaultChild as CfnResource;
    const stack = Stack.of(this);

    // Lazy: synth時にpoliciesの現在値を解決する
    this.resource = new CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      properties: {
        policyEngineName: this.policyEngineName,
        policies: Lazy.any({ produce: () => this.policies }),
        gatewayId: props.gateway.gatewayId,
        gatewayName: props.gateway.name,
        gatewayRoleArn: props.gateway.role.roleArn,
        // Gateway L1プロパティの変更を検知するトリガー（handler側では使用しない）
        // stack.resolve() でトークンを解決してからハッシュ化する
        _gatewayTrigger: Lazy.string({
          produce: () => {
            const resolved = stack.resolve(cfnGateway._toCloudFormation());
            return createHash('sha256').update(JSON.stringify(resolved)).digest('hex');
          },
        }),
      },
    });

    this.resource.node.addDependency(props.gateway);

    this.policyEngineId = this.resource.getAttString('policyEngineId');

    // Lazy validation: ポリシーが1つも追加されていない場合にエラー
    this.node.addValidation({
      validate: () => {
        if (this.policies.length === 0) {
          return ['PolicyEngine には少なくとも1つのポリシーを addPolicy() または addCedarPolicy() で追加してください'];
        }
        return [];
      },
    } satisfies IValidation);
  }

  /**
   * cognito:groups × ツール名のマトリクスでポリシーを追加する。
   * Gateway ARN は自動的に注入される。
   */
  addPolicy(name: string, options: GroupToolsPolicyOptions): void {
    this.validatePolicyName(name);
    if (options.tools.length === 0) {
      throw new Error(`PolicyEngine: ポリシー '${name}' の tools は空にできません`);
    }

    const statement = generateCedarStatement(this.gateway.gatewayArn, options.group, options.tools);
    this.policies.push({ name: this.prefixedPolicyName(name), statement });
  }

  /**
   * エスケープハッチ: 生のCedar文を直接渡す。
   */
  addCedarPolicy(name: string, options: CedarPolicyOptions): void {
    this.validatePolicyName(name);
    this.policies.push({ name: this.prefixedPolicyName(name), statement: options.statement });
  }

  private validatePolicyName(name: string): void {
    if (this.policyNames.has(name)) {
      throw new Error(`PolicyEngine: ポリシー名 '${name}' は既に追加されています`);
    }
    const prefixed = this.prefixedPolicyName(name);
    if (prefixed.length > 48) {
      throw new Error(
        `PolicyEngine: プレフィックス付きポリシー名 '${prefixed}' が48文字を超えています (${prefixed.length}文字)`,
      );
    }
    this.policyNames.add(name);
  }

  /** ポリシー名にPolicy Engine名由来の短いプレフィックスを付与（アカウント内でユニークにする） */
  private prefixedPolicyName(name: string): string {
    return `${this.policyNamePrefix}_${name}`;
  }
}
