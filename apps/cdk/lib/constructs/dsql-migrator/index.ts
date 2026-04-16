import { CfnOutput, Duration, IgnoreMode, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { DockerImageFunction, Architecture } from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { Trigger } from 'aws-cdk-lib/triggers';
import { type Database } from '../database';
import { join } from 'path';
import { ContainerImageBuild } from '@cdklabs/deploy-time-build';
import { parseDockerignore } from '../../utils';

export interface DsqlMigratorProps {
  readonly database: Database;
}

export class DsqlMigrator extends Construct {
  constructor(scope: Construct, id: string, props: DsqlMigratorProps) {
    super(scope, id);

    const { database } = props;

    const image = new ContainerImageBuild(this, 'Build', {
      directory: join(__dirname, '..', '..', '..', '..', '..'),
      platform: Platform.LINUX_ARM64,
      file: 'packages/db/Dockerfile.migrator',
      ignoreMode: IgnoreMode.DOCKER,
      exclude: parseDockerignore(join(__dirname, '..', '..', '..', '..', '..', '.dockerignore')),
    });

    const migrationRunner = new DockerImageFunction(this, 'Handler', {
      code: image.toLambdaDockerImageCode(),
      architecture: Architecture.ARM_64,
      timeout: Duration.minutes(15),
      environment: {
        ...database.getLambdaEnvironment(),
        // imageTag を環境変数に含めることで、イメージ更新時に Lambda 関数の UPDATE を強制する
        BUILD_TAG: image.imageTag,
      },
      memorySize: 2048,
      logGroup: new LogGroup(this, 'Logs', {
        retention: RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    database.grantConnect(migrationRunner);

    const trigger = new Trigger(this, 'Trigger', { handler: migrationRunner });
    trigger.node.addDependency(database.cluster);

    new CfnOutput(Stack.of(this), 'MigrationFunctionName', { value: migrationRunner.functionName });
  }
}
