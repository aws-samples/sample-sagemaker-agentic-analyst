import { CfnOutput, type CfnResource, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { BlockPublicAccess, Bucket, BucketEncryption, HttpMethods, ObjectOwnership } from 'aws-cdk-lib/aws-s3';
import { type Construct } from 'constructs';
import { HostedZone } from 'aws-cdk-lib/aws-route53';
import { type ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { type IUserPool, type IUserPoolClient } from 'aws-cdk-lib/aws-cognito';
import { Webapp } from './constructs/webapp';
import { type EdgeFunction } from './constructs/cf-lambda-furl-service/edge-function';
import { DataAccess } from './constructs/data-access';
import { Agent } from './constructs/agent';
import { Database } from './constructs/database';
import { DsqlMigrator } from './constructs/dsql-migrator';
import { Project } from 'aws-cdk-lib/aws-codebuild';

export interface AgenticAnalystStackProps extends StackProps {
  readonly signPayloadHandler: EdgeFunction;

  /** IAM Identity CenterインスタンスARN（組織インスタンス必須） */
  readonly idcInstanceArn: string;

  /** Identity Store ID */
  readonly identityStoreId: string;

  /** DataZoneドメインID */
  readonly datazoneDomainId: string;

  /** IdCポータルURL（サインアウト時のIdCセッション破棄用） */
  readonly idcPortalUrl?: string;

  /** IdC OAuth CMA ARN（TIP用） */
  readonly idcApplicationArn?: string;

  /** IdC SAML Metadata URL（IdP-initiated SSO用） */
  readonly idcSamlMetadataUrl?: string;

  /** カスタムドメイン名 */
  readonly domainName?: string;

  /** Bedrockモデル ID（例: jp.anthropic.claude-sonnet-4-6） */
  readonly bedrockModelId?: string;

  /** 環境名（例: 'dev', 'stg'）。未指定なら無印環境 */
  readonly envName?: string;

  /** Chronos-2 時系列予測機能を有効化するか */
  readonly enableTimeSeries?: boolean;

  /** us-east-1のACM証明書 */
  readonly sharedCertificate?: ICertificate;

  // IdStoreStackから
  readonly userPool: IUserPool;
  readonly userPoolClient: IUserPoolClient;
  readonly cognitoDomainName: string;
}

export class AgenticAnalystStack extends Stack {
  constructor(scope: Construct, id: string, props: AgenticAnalystStackProps) {
    super(scope, id, { description: 'Agentic Analyst - Main Stack', ...props });

    const hostedZone = props.domainName
      ? HostedZone.fromLookup(this, 'HostedZone', { domainName: props.domainName })
      : undefined;

    const accessLogBucket = new Bucket(this, 'AccessLogBucket', {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: ObjectOwnership.OBJECT_WRITER,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const dataAccess = new DataAccess(this, 'DataAccess', {});

    const database = new Database(this, 'Database');
    new DsqlMigrator(this, 'DsqlMigrator', { database });

    const agent = new Agent(this, 'Agent', {
      datazoneDomainId: props.datazoneDomainId,
      cloudtrailEventDataStoreId: dataAccess.eventDataStoreId,
      userPool: props.userPool,
      userPoolClient: props.userPoolClient,
      idcApplicationArn: props.idcApplicationArn,
      bedrockModelId: props.bedrockModelId,
      envName: props.envName,
      database,
      enableTimeSeries: props.enableTimeSeries,
    });

    const webapp = new Webapp(this, 'Webapp', {
      hostedZone,
      certificate: props.sharedCertificate,
      signPayloadHandler: props.signPayloadHandler,
      accessLogBucket,
      userPool: props.userPool,
      userPoolClient: props.userPoolClient,
      cognitoDomainName: props.cognitoDomainName,
      subDomain: 'web',
      datazoneDomainId: props.datazoneDomainId,
      agentcoreRuntimeArn: agent.runtime.agentRuntimeArn,
      agentcoreMemoryId: agent.memoryId,
      database,
      idcPortalUrl: props.idcPortalUrl,
      identityStoreId: props.identityStoreId,
      idcApplicationArn: props.idcApplicationArn,
      cloudtrailEventDataStoreId: dataAccess.eventDataStoreId,
      idcSamlMetadataUrl: props.idcSamlMetadataUrl,
    });

    // Storage Browser for S3 はブラウザから直接S3 APIを呼ぶため、webappオリジンのCORSを許可する。
    // SMUSが設定したCORSルール（SMUSのURL）はCDKが上書きするため、SMUSのオリジンも含める。
    dataAccess.dataBucket.addCorsRule({
      allowedMethods: [HttpMethods.GET, HttpMethods.HEAD, HttpMethods.PUT, HttpMethods.POST, HttpMethods.DELETE],
      allowedOrigins: [
        webapp.baseUrl,
        'http://localhost:3012',
        // SMUSが元々設定していたオリジン（SMUSのURL）
        `https://${props.datazoneDomainId}.sagemaker.${this.region}.on.aws`,
      ],
      allowedHeaders: ['*'],
      exposedHeaders: [
        'last-modified',
        'content-type',
        'content-length',
        'etag',
        'x-amz-version-id',
        'x-amz-request-id',
        'x-amz-id-2',
        'x-amz-cf-id',
        'x-amz-storage-class',
        'date',
        'access-control-expose-headers',
      ],
      maxAge: 3000,
    });

    // Escape hatch: ContainerImageBuild の computeType を MEDIUM に変更
    // SingletonProject がスタック直下に作る CodeBuild Project を探して上書き
    const arm64Project = this.node.children.find(
      (c): c is Project => c instanceof Project && c.node.id.startsWith('ContainerImageBuildArm64'),
    );
    if (arm64Project) {
      (arm64Project.node.defaultChild as CfnResource).addPropertyOverride(
        'Environment.ComputeType',
        'BUILD_GENERAL1_MEDIUM',
      );
    }

    new CfnOutput(this, 'FrontendDomainName', { value: webapp.baseUrl });
    new CfnOutput(this, 'GatewayArn', { value: agent.gateway.gatewayArn });
    new CfnOutput(this, 'RuntimeArn', { value: agent.runtime.agentRuntimeArn });
    new CfnOutput(this, 'DsqlEndpoint', { value: database.endpoint });
    new CfnOutput(this, 'AgentCoreMemoryId', { value: agent.memoryId });
    new CfnOutput(this, 'DataBucketName', { value: dataAccess.dataBucket.bucketName });
    new CfnOutput(this, 'AthenaResultsBucketName', { value: dataAccess.athenaResultsBucket.bucketName });
    if (props.idcPortalUrl) {
      new CfnOutput(this, 'IdcPortalUrl', { value: props.idcPortalUrl });
    }
  }
}
