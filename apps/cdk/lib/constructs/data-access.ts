import { RemovalPolicy } from 'aws-cdk-lib';
import { ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { BlockPublicAccess, Bucket, BucketEncryption, type IBucket } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { CfnEventDataStore } from 'aws-cdk-lib/aws-cloudtrail';
import { Construct } from 'constructs';

export interface DataAccessProps {
  // 将来の拡張用（現在は空）
}

/**
 * データアクセス層: S3, CloudTrail Lake
 *
 * Glue Database/Tables/Athena WorkgroupはSMUSが自動作成する。
 * CDKはインフラ基盤（S3バケット、CloudTrail Lake）のみを管理。
 * FGACはSMUS Pub/Subが自動設定する。
 */
export class DataAccess extends Construct {
  /** デモデータ格納用S3バケット */
  public readonly dataBucket: Bucket;
  /** Athena結果格納用S3バケット */
  public readonly athenaResultsBucket: IBucket;
  /** CloudTrail Lake Event Data Store ID */
  public readonly eventDataStoreId: string;

  constructor(scope: Construct, id: string, _props: DataAccessProps) {
    super(scope, id);

    // --- S3バケット ---
    const dataBucket = new Bucket(this, 'DataBucket', {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    this.dataBucket = dataBucket;

    // Lake Formation SLR がデータレイクロケーション登録後にバケットを読み取れるようにする
    // register-resource --use-service-linked-role で登録する前提（docs/02-sagemaker-config.md Phase 2）
    dataBucket.grantRead(new ServicePrincipal('lakeformation.amazonaws.com'));

    // サンプルデータのデプロイ
    new BucketDeployment(this, 'DeploySampleData', {
      sources: [Source.asset('./sample-data')],
      destinationBucket: dataBucket,
    });

    // --- CloudTrail Lake ---
    const eventDataStore = new CfnEventDataStore(this, 'EventDataStore', {
      multiRegionEnabled: true,
      retentionPeriod: 90,
      terminationProtectionEnabled: false,
    });
    this.eventDataStoreId = eventDataStore.attrEventDataStoreArn;

    // --- Athena結果バケット ---
    this.athenaResultsBucket = new Bucket(this, 'AthenaResultsBucket', {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
  }
}
