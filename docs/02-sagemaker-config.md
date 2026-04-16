# SageMaker Unified Studio 設定ガイド

このドキュメントでは、CDKデプロイ後のSMUS設定手順を説明します。

**対象ペルソナ:** インフラ管理者、データプロデューサー

**Phase 1-5:** プロジェクト作成 → データ準備 → FGAC設定

**前提:** [01-deployment.md](./01-deployment.md) が完了していること

**次のステップ:** [03-e2e-testing.md](./03-e2e-testing.md)

## 概要

### SMUSの権限モデル

**重要**: SMUSのプロジェクトメンバーシップ（Owner/Contributor）は、プロジェクトに関連付けられた**すべてのデータ**へのアクセスを許可します。テーブルレベルのFGACを実現するには、**プロジェクトを分ける**必要があります。

| アプローチ               | 結果                               | 用途                                 |
| ------------------------ | ---------------------------------- | ------------------------------------ |
| プロジェクトメンバー追加 | 全テーブルにアクセス可能           | 全データへのアクセスが必要なユーザー |
| 別プロジェクト + Share   | 共有されたテーブルのみアクセス可能 | 一部テーブルのみ許可するユーザー     |

### プロジェクト構成

| プロジェクト           | プロファイル     | Owner         | メンバー            | アクセス可能テーブル    |
| ---------------------- | ---------------- | ------------- | ------------------- | ----------------------- |
| `demo-salesdb-project` | All capabilities | dg-data-owner | -                   | 全5テーブル             |
| `analyst-data-access`  | SQL analytics    | dg-data-owner | dg-business-analyst | 共有された3テーブルのみ |

### 期待される権限マトリクス

#### テーブルレベルFGAC（Lake Formation）

| テーブル                    | dg-data-owner | dg-business-analyst | dg-corp-admin |
| --------------------------- | ------------- | ------------------- | ------------- |
| store_details               | ✅ READ       | ✅ READ             | ❌            |
| retail_sales_performance    | ✅ READ       | ✅ READ             | ❌            |
| ecommerce_customer_behavior | ✅ READ       | ✅ READ             | ❌            |
| sales_rep_performance       | ✅ READ       | ❌                  | ❌            |
| b2b_sales_pipeline          | ✅ READ       | ❌                  | ❌            |

#### S3 Access Grants（ファイルレベル）

| パス                          | dg-data-owner | dg-business-analyst | dg-corp-admin |
| ----------------------------- | ------------- | ------------------- | ------------- |
| `unstructured/public/*`       | ✅            | ✅                  | ❌            |
| `unstructured/confidential/*` | ✅            | ❌                  | ❌            |

## Phase 1: SMUSプロジェクト作成

### Step 1.1: DataZoneコンソールでユーザーの確認

1. AWSコンソール → DataZone → ドメイン
2. 対象ドメイン（例: `Corporate`）をクリック
3. 「ユーザー管理」タブで以下のユーザーが追加されていることを確認:
   - `dg-data-owner`
   - `dg-business-analyst`
   - `dg-corp-admin`

### Step 1.2: Lakehouseオンボード済みの確認

Quick Setupでドメインを作成した場合、AWS Glue (SageMaker Lakehouse) のオンボードはドメイン作成時に自動実行されており、`admin-project-*` という名前のAdmin projectが自動作成されています。再度オンボードを実行すると `Admin project already exists for the selected resource type` エラーになるため、ここでは確認のみ行います。

1. DataZoneドメイン詳細 → 「オンボーディングされたデータ」タブ
2. AWS Glue (SageMaker Lakehouse) がオンボード済みであることを確認

> **注意**: Admin projectはドメイン管理用の内部プロジェクトであり、`demo-salesdb-project` とは別物です。`demo-salesdb-project` は次のステップで手動作成します。

### Step 1.3: Publisherプロジェクトの作成

SMUSで `demo-salesdb-project`（Publisherプロジェクト）を作成します。

1. SMUS（`https://dzd-xxxxxxxxx.sagemaker.<region>.on.aws/`）に `dg-data-owner` でログイン
2. **Projects** → **Create project** をクリック
3. 以下を入力:
   - Project name: `demo-salesdb-project`
   - Description: `Publisher project - all sales data`
   - Project profile: **All capabilities**
4. **Create project** をクリック
5. プロジェクト作成完了まで待機（Tooling環境のプロビジョニングに数分かかる）

### Step 1.4: Subscriberプロジェクトの作成

SMUSで `analyst-data-access`（Subscriberプロジェクト）を作成します。

1. `dg-data-owner` でログインした状態で **Projects** → **Create project** をクリック
2. 以下を入力:
   - Project name: `analyst-data-access`
   - Description: `Subscriber project - general sales data only`
   - Project profile: **SQL analytics**
3. **Create project** をクリック
4. プロジェクト作成完了まで待機（Tooling環境のプロビジョニングに数分かかる）

> **注意**: Subscriberプロジェクトのプロジェクトプロファイルには `LakeHouseDatabase` ブループリントが含まれている必要があります（Subscription Targetの作成に必須）。AWS公式テンプレート（SQL analytics, All capabilities）には含まれるため、カスタムプロファイルを使わない限り問題は発生しません。

### Step 1.5: Subscriberプロジェクトにメンバーを追加

1. `analyst-data-access` プロジェクトに移動
2. **Settings** → **Members** → **Add member** をクリック
3. `dg-business-analyst` を検索して選択
4. Role: **Contributor** を選択
5. **Add member** をクリック

### Step 1.6: プロジェクトの確認

以下の2プロジェクトが存在し、メンバーが正しいことを確認:

| プロジェクト           | プロファイル     | Owner         | メンバー                          |
| ---------------------- | ---------------- | ------------- | --------------------------------- |
| `demo-salesdb-project` | All capabilities | dg-data-owner | -                                 |
| `analyst-data-access`  | SQL analytics    | dg-data-owner | dg-business-analyst (Contributor) |

各プロジェクトのTooling Environmentが作成完了していることを確認（数分かかる）。

## Phase 2: Glue Database/Tables作成

CDKはサンプルCSVデータをS3にデプロイしますが、Glue Database/TablesはSMUSで作成します。これにより、SMUSのFGAC機能と連携できます。

### Step 2.1: データバケット名の確認

```bash
DATA_BUCKET=$(aws cloudformation describe-stacks --stack-name AgenticAnalyst \
  --query 'Stacks[0].Outputs[?OutputKey==`DataBucketName`].OutputValue' --output text)
echo $DATA_BUCKET
```

### Step 2.2: Lake Formationロケーション登録 + DATA_LOCATION_ACCESS 付与

データバケットをLake Formationに登録し、プロジェクトロールに `DATA_LOCATION_ACCESS` を付与します。これにより、SMUSクエリエディタから `CREATE EXTERNAL TABLE` でデータバケット上のCSVを参照するテーブルを作成できるようになります。

> **背景**: LF管理下のS3ロケーションにテーブルを作成するには `CREATE_TABLE` + `DATA_LOCATION_ACCESS` が必要です（[LF権限リファレンス](https://docs.aws.amazon.com/lake-formation/latest/dg/lf-permissions-reference.html)）。`DATA_LOCATION_ACCESS` はメタデータ作成権限であり、データアクセス権限（`SELECT` 等）ではないため、FGACには影響しません。

```bash
# DOMAIN_ID, PROJECT_ID は Step 1.6 で確認した値
./scripts/grant-lf-location.sh <DATA_BUCKET> <DOMAIN_ID> <PROJECT_ID>
```

### Step 2.3: SMUSクエリエディタでテーブルを作成

1. SMUS（`https://dzd-xxxxxxxxx.sagemaker.<region>.on.aws/`）に `dg-data-owner` でログイン
2. **Projects** → `demo-salesdb-project` を選択
3. **Data** → **Lakehouse** → **AwsDataCatalog** → `glue_db_*` を展開
4. データベース名の横の三点メニュー → **Query with Athena** をクリック
5. 以下の5つの `CREATE EXTERNAL TABLE` を**1つずつ別のセルで**実行（`<DATA_BUCKET>` はStep 2.1で確認した値に置き換え）:

```sql
CREATE EXTERNAL TABLE store_details (
  store_id string, store_name string, store_city string,
  store_state string, store_zip string,
  store_open_date string, store_closed_date string
)
ROW FORMAT SERDE 'org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe'
WITH SERDEPROPERTIES ('field.delim' = ',', 'serialization.format' = ',')
STORED AS TEXTFILE
LOCATION 's3://<DATA_BUCKET>/raw/sales/store_details/'
TBLPROPERTIES ('skip.header.line.count' = '1')
```

```sql
CREATE EXTERNAL TABLE retail_sales_performance (
  date string, store_id string, product_id string,
  sales_amount string, units_sold string
)
ROW FORMAT SERDE 'org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe'
WITH SERDEPROPERTIES ('field.delim' = ',', 'serialization.format' = ',')
STORED AS TEXTFILE
LOCATION 's3://<DATA_BUCKET>/raw/sales/retail_sales_performance/'
TBLPROPERTIES ('skip.header.line.count' = '1')
```

```sql
CREATE EXTERNAL TABLE ecommerce_customer_behavior (
  date string, customer_id string, product_id string,
  page_views string, purchase_amount string
)
ROW FORMAT SERDE 'org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe'
WITH SERDEPROPERTIES ('field.delim' = ',', 'serialization.format' = ',')
STORED AS TEXTFILE
LOCATION 's3://<DATA_BUCKET>/raw/sales/ecommerce_customer_behavior/'
TBLPROPERTIES ('skip.header.line.count' = '1')
```

```sql
CREATE EXTERNAL TABLE sales_rep_performance (
  date string, sales_rep_id string, total_sales_amount string,
  deals_closed string, customer_satisfaction_score string
)
ROW FORMAT SERDE 'org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe'
WITH SERDEPROPERTIES ('field.delim' = ',', 'serialization.format' = ',')
STORED AS TEXTFILE
LOCATION 's3://<DATA_BUCKET>/raw/sales/sales_rep_performance/'
TBLPROPERTIES ('skip.header.line.count' = '1')
```

```sql
CREATE EXTERNAL TABLE b2b_sales_pipeline (
  date string, sales_rep_id string, customer_id string,
  deal_value string, pipeline_stage string
)
ROW FORMAT SERDE 'org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe'
WITH SERDEPROPERTIES ('field.delim' = ',', 'serialization.format' = ',')
STORED AS TEXTFILE
LOCATION 's3://<DATA_BUCKET>/raw/sales/b2b_sales_pipeline/'
TBLPROPERTIES ('skip.header.line.count' = '1')
```

6. Lakehouse のデータエクスプローラーを更新し、5テーブルが表示されることを確認

### Step 2.4: デフォルトデータソースのPublish設定+実行

GlueテーブルはそのままではDataZoneのAssetにならず、Publish/Subscribeの対象にできません。SMUSがプロジェクト作成時に自動作成したデフォルトデータソースのPublish設定を有効にし、実行してAssetとして取り込みます。

> **注意**: `glue_db_*` を使用しているため、データソースはプロジェクト作成時に自動作成済みです（`<account-id>-AwsDataCatalog-glue_db_<id>-default-datasource` のような名前）。新しいデータソースを作成する必要はありません。

1. SMUS → `demo-salesdb-project` プロジェクトに移動
2. 左ナビの **Project catalog** → **Data sources** をクリック
3. 既存のデフォルトデータソース（`...-default-datasource`）を選択
4. **Publishing settings** セクションの **Publish assets to the Catalog** を **Edit** → **Yes** に変更
5. データソースを **Run** をクリック
6. ステータスが `SUCCESS` になるまで待機（数分）

期待される結果: 5テーブルがAssetとして取り込まれ、自動的にPublish（listing ACTIVE）されます。

**確認:**

- **Project catalog → Assets → Published** タブで5テーブルが表示されること

## Phase 3: テーブルのSubscribe設定

### Step 3.1: ConsumerProjectで一般テーブル3つをSubscribe

`analyst-data-access` プロジェクトを選択:

1. **Discover → Catalog → Browse assets** に移動
2. 以下の3テーブルをそれぞれSubscribe:
   - `store_details`
   - `retail_sales_performance`
   - `ecommerce_customer_behavior`
3. 各テーブルの「Subscribe」ボタンをクリック
4. Project: `analyst-data-access` を選択
5. Reason: `E2E test` を入力
6. 「Subscribe」をクリック

## Phase 4: S3 Access Grants設定

設計判断・責務分担・禁止操作については [data-access-control.md](../design/data-access-control.md) を参照。

### Step 4.1: Publisherプロジェクトロールに権限を追加

SMUSがS3ロケーション追加時にS3 Access Grants Locationを自動作成するには、プロジェクトロールにS3バケットアクセス権限とS3AG Location管理権限が必要です。プロジェクトロールはSMUSプロジェクト作成時に自動生成されるため、CDKでは自動化できません。

```bash
# DATA_BUCKET, DOMAIN_ID, PROJECT_ID は Step 2.1, 1.6 で確認した値
./scripts/grant-s3ag-permissions.sh <DATA_BUCKET> unstructured <DOMAIN_ID> <PROJECT_ID>
```

### Step 4.2: demo-salesdb-projectに外部S3バケットを追加

SMUS UIでS3ロケーションを追加します。Project Role方式（Access Role空）で作成すると、SMUSが自動的にS3 Access Grants Locationを作成し、コネクションに紐付けます。

1. `demo-salesdb-project` に移動
2. **Data** → **add data source** をクリック
3. **Add S3 location** を選択
4. 以下を入力:
   - Name: `unstructured-s3`
   - S3 URI: `s3://<データバケット名>/unstructured/`（CDK Outputsで確認）
   - AWS region: `ap-northeast-1`
   - **Access role ARN**: 空のまま（Project Role方式）
5. **Add S3 location** をクリック

> **SMUSの自動処理:** Access Roleを空にすると、SMUSはプロジェクトロールを使用してS3 Access Grants Locationを自動作成し、コネクションの`s3AccessGrantLocationId`に設定します。Step 4.1でプロジェクトロールに`s3:CreateAccessGrantsLocation`権限を付与しているため、この自動作成が成功します。

### Step 4.3: publicフォルダをPublish + Share

1. **Data** → **Buckets** → **S3 (unstructured-s3.s3)** → `public` を選択
2. **Actions** → **Publish to Catalog** をクリック
3. **Project catalog → Assets → Published** タブで `public/` が表示されることを確認
4. `public/` アセットをクリック → **Actions** → **Share** をクリック
5. `analyst-data-access` プロジェクトを選択
6. アクセスタイプ: **Read access**
7. **Share** をクリック

## 次のステップ

[03-e2e-testing.md](./03-e2e-testing.md) に進み、E2Eテストを実施してください (任意)。
