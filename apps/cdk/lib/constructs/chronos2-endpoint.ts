/**
 * Chronos-2 時系列予測エンドポイント
 *
 * SageMaker JumpStart の `pytorch-forecasting-chronos-2` モデルを、
 * ap-northeast-1 の公開 ECR / S3 アーティファクトから CfnModel で直接デプロイする。
 * Custom Resource や Python SDK は使わない（JumpStart の model spec を直接参照）。
 */

import type * as cdk from 'aws-cdk-lib';
import { Effect, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { CfnModel, CfnEndpoint, CfnEndpointConfig } from 'aws-cdk-lib/aws-sagemaker';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

const REGION = 'ap-northeast-1';

// ap-northeast-1 で公開されている JumpStart model spec から取得した値
// （aws sagemaker describe-hub-content --hub-content-name pytorch-forecasting-chronos-2 で確認済み）
const CHRONOS_CPU_IMAGE_URI = `763104351884.dkr.ecr.${REGION}.amazonaws.com/pytorch-inference:2.5.1-cpu-py311`;
const CHRONOS_MODEL_ARTIFACTS_S3 = `s3://jumpstart-cache-prod-${REGION}/pytorch-forecasting/pytorch-forecasting-chronos-2/artifacts/inference-prepack/v1.1.0/`;
const JUMPSTART_CACHE_BUCKET = `jumpstart-cache-prod-${REGION}`;

export interface Chronos2EndpointProps {
  /** 環境名（例: 'dev', 'stg'）。未指定なら無印環境 */
  readonly envName?: string;
  /** インスタンスタイプ（デフォルト ml.c7i.xlarge） */
  readonly instanceType?: string;
}

/**
 * SageMaker Real-time Endpoint で Chronos-2 をホストする。
 * 単系列・少数系列予測用途のため CPU インスタンスで十分。
 */
export class Chronos2Endpoint extends Construct {
  readonly endpointName: string;

  constructor(scope: Construct, id: string, props: Chronos2EndpointProps = {}) {
    super(scope, id);

    const instanceType = props.instanceType ?? 'ml.c7i.xlarge';

    // SageMaker Execution Role（JumpStart キャッシュバケットへの読み取り + ログ書き込み）
    const executionRole = new Role(this, 'ExecutionRole', {
      assumedBy: new ServicePrincipal('sagemaker.amazonaws.com'),
    });
    executionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['s3:ListBucket'],
        resources: [`arn:aws:s3:::${JUMPSTART_CACHE_BUCKET}`],
      }),
    );
    executionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['s3:GetObject'],
        resources: [`arn:aws:s3:::${JUMPSTART_CACHE_BUCKET}/*`],
      }),
    );
    executionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents', 'logs:CreateLogGroup', 'logs:DescribeLogStreams'],
        resources: ['*'],
      }),
    );
    executionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage'],
        resources: ['*'],
      }),
    );
    executionRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );

    // ログ取得のためにあらかじめ LogGroup を作っておく（SageMaker が書き込む）
    new LogGroup(this, 'EndpointLogs', {
      logGroupName: `/aws/sagemaker/Endpoints/${props.envName ? `${props.envName}-` : ''}agentic-analyst-chronos2`,
      retention: RetentionDays.ONE_WEEK,
    });

    const model = new CfnModel(this, 'Model', {
      executionRoleArn: executionRole.roleArn,
      primaryContainer: {
        image: CHRONOS_CPU_IMAGE_URI,
        modelDataSource: {
          s3DataSource: {
            s3Uri: CHRONOS_MODEL_ARTIFACTS_S3,
            s3DataType: 'S3Prefix',
            compressionType: 'None',
          },
        },
        mode: 'SingleModel',
        environment: {
          SAGEMAKER_PROGRAM: 'inference.py',
          SAGEMAKER_SUBMIT_DIRECTORY: '/opt/ml/model/code',
          MODEL_CACHE_ROOT: '/opt/ml/model',
          SAGEMAKER_ENV: '1',
          ENDPOINT_SERVER_TIMEOUT: '120',
          SAGEMAKER_MODEL_SERVER_TIMEOUT: '3600',
          SAGEMAKER_MODEL_SERVER_WORKERS: '1',
          SAGEMAKER_CONTAINER_LOG_LEVEL: '20',
        },
      },
    });

    // CfnModel は ExecutionRole を使って S3 アクセスチェックを行うため、
    // DefaultPolicy（addToPolicy で作成）がアタッチされる前に Model 作成が走るとエラーになる。
    // L1 リソースでは依存が自動解決されないので明示的に addDependency する。
    const defaultPolicy = executionRole.node.tryFindChild('DefaultPolicy')?.node.defaultChild;
    if (defaultPolicy) {
      model.addDependency(defaultPolicy as cdk.CfnResource);
    }

    // 同一エンドポイントで EndpointConfig を変更するたびに CFn は replace しようとするため
    // EndpointConfig 名は Construct から一意に導出（ただし短めに）
    const endpointConfig = new CfnEndpointConfig(this, 'EndpointConfig', {
      productionVariants: [
        {
          variantName: 'AllTraffic',
          modelName: model.attrModelName,
          instanceType,
          initialInstanceCount: 1,
          initialVariantWeight: 1,
        },
      ],
    });
    endpointConfig.addDependency(model);

    const endpointName = `${props.envName ? `${props.envName}-` : ''}agentic-analyst-chronos2`;
    const endpoint = new CfnEndpoint(this, 'Endpoint', {
      endpointName,
      endpointConfigName: endpointConfig.attrEndpointConfigName,
    });
    endpoint.addDependency(endpointConfig);

    this.endpointName = endpointName;
  }
}
