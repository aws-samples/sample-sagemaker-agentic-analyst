# Agentic Analyst - 要求定義書

## 概要

### 目的

**Agentic Analyst**の実現可能性を実証する。

SageMaker Unified Studio (SMUS) で設定したFine-grained Access Control (FGAC)（行・列レベルのアクセス制御）が、以下の両方で透過的に適用されることを検証する:

1. SMUS / Webアプリからの直接クエリ
2. Bedrock AgentCore経由のAIエージェントアクセス

### 作るもの

1. **Webアプリ**: Athenaクエリ実行UI + AIエージェントチャットUI
2. **AIエージェント**: Bedrock AgentCore上で動作し、ユーザーの権限に応じたデータアクセスを行う

### 核心的な制約

- データ利用者（ドメイン管理者、データプロデューサー、データコンシューマー）はSMUSだけを見る
- インフラ管理者はSMUSとIAM Identity Center (IdC) だけを見る
- 開発者以外にLake Formation, DataZone API, S3 Access Grantsは露出しない

### デモの設計方針

デモの目的は「AI Ready Data Platformの実現性の証明」と「運用イメージを持ってもらうこと」。CDKで作りすぎるとブラックボックスになり運用イメージが伝わらない。一方で、SMUSの前提条件（LFロケーション登録等）を手動でやらせると「設定が複雑すぎる」という印象だけが残る。

**「見せたい操作」と「見せなくていい前提条件」を分ける:**

| CDKで自動化（見せない） | デモで見せる（SMUS操作）                                              |
| ----------------------- | --------------------------------------------------------------------- |
| S3バケット作成          | テーブル定義・データ投入                                              |
| LFロケーション登録      | データソース作成・実行（SMUS UI）                                     |
| Cognito, AgentCore      | S3ロケーション追加（Project Role方式、SMUSがS3AG Locationを自動作成） |
| CloudTrail Lake         | Publish / Share / Subscribe                                           |
|                         | Subscription承認 → LF権限自動付与                                     |
|                         | S3 Access Grants自動作成                                              |

> **注意**: S3ロケーション追加にはProject Role方式を採用する。プロジェクトロールへの権限追加（D3）はCDKで自動化できない（プロジェクトロールはSMUSプロジェクト作成時に自動生成されるため、CDK時点でARNが不明）。D3は開発者が実施する事前準備としてランブックに残す。

### 実証するAWS機能

| 機能                                                                                                                                              | 用途                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| SSO-OIDC CreateTokenWithIAM                                                                                                                       | Cognito ID Token → IdC Access Token変換            |
| DataZone [RedeemAccessToken](https://docs.aws.amazon.com/datazone/latest/userguide/query-with-jdbc.html)                                          | IdC Access Token → DomainExecutionRole認証情報取得 |
| DataZone GetEnvironmentCredentials                                                                                                                | プロジェクトロール認証情報の取得                   |
| Lake Formation                                                                                                                                    | テーブル・行・列レベルのアクセス制御               |
| S3 Access Grants                                                                                                                                  | ファイルレベルのアクセス制御                       |
| Bedrock [AgentCore](https://aws.amazon.com/blogs/machine-learning/apply-fine-grained-access-control-with-bedrock-agentcore-gateway-interceptors/) | AIエージェントのホスティング                       |
| Bedrock AgentCore Memory                                                                                                                          | チャット履歴（メッセージ本文）保存                 |
| Bedrock AgentCore Code Interpreter                                                                                                                | サンドボックス環境でのコード実行・データ可視化     |
| Aurora DSQL                                                                                                                                       | セッションメタデータ保存                           |
| DataZone Catalog                                                                                                                                  | データカタログ検索・スキーマ取得                   |
| CloudTrail Lake                                                                                                                                   | 監査ログ検索                                       |

---

## ペルソナ別の関心事

### SMUSのプレーン構成

SMUSは3つのプレーンで構成される（[参照](https://aws.amazon.com/blogs/big-data/foundational-blocks-of-amazon-sagemaker-unified-studio-an-admins-guide-to-implement-unified-access-to-all-your-data-analytics-and-ai/)）:

| プレーン           | 責務                     | 主な操作                                                                 |
| ------------------ | ------------------------ | ------------------------------------------------------------------------ |
| Infrastructure     | 基盤構築・ガバナンス設定 | ドメイン作成、ユーザーオンボード、ブループリント有効化、データソース接続 |
| Data Factory       | データ処理・開発環境     | プロジェクト作成、ETLジョブ、ノートブック、コンピュートリソース管理      |
| Product Experience | データ発見・共有・消費   | カタログ閲覧、Publish/Subscribe、FGAC設定、SQLクエリ実行                 |

### ペルソナ定義

| ペルソナ             | 説明                                                                     | 本デモでの該当者    |
| -------------------- | ------------------------------------------------------------------------ | ------------------- |
| ドメイン管理者       | ドメイン・認可ポリシー管理                                               | dg-corp-admin       |
| データプロデューサー | データ定義（スキーマ設計）、データ投入、Publish、FGAC設定、Subscribe承認 | dg-data-owner       |
| データコンシューマー | データSubscribe、クエリ実行                                              | dg-business-analyst |
| インフラ管理者       | ドメイン作成、データソース接続、ETL                                      | デモ実施者（SA）    |
| 開発者               | CDK、webapp実装                                                          | デモ実施者（SA）    |

### ドメイン管理者の関心事

**目標:** SMUSだけを見てドメインを管理できる

| 操作               | 使用するUI | 備考                          |
| ------------------ | ---------- | ----------------------------- |
| Domain Units作成   | SMUS       | 組織階層の定義                |
| 認可ポリシー設定   | SMUS       | ユーザー/プロジェクトポリシー |
| CloudTrailログ検索 | webapp     | 本デモ独自機能                |

**原則:** Lake Formation, DataZone API, S3 Access Grantsは完全に隠蔽される

### データプロデューサーの関心事

**目標:** SMUSだけを見てデータを定義・公開・共有できる

| 操作                       | 使用するUI    | 備考                                   |
| -------------------------- | ------------- | -------------------------------------- |
| データ定義（スキーマ設計） | SMUS          | Glue Database/Table作成、CSVインポート |
| データPublish              | SMUS          | 自プロジェクトのデータをカタログに公開 |
| FGAC設定（行・列フィルタ） | SMUS          | サブスクリプション承認時に適用         |
| サブスクリプション承認     | SMUS          |                                        |
| SQLクエリ実行              | SMUS / webapp |                                        |

**原則:** Lake Formation, DataZone API, S3 Access Grantsは完全に隠蔽される

### データコンシューマーの関心事

**目標:** SMUSだけを見てデータにアクセスできる

| 操作               | 使用するUI    | 備考                             |
| ------------------ | ------------- | -------------------------------- |
| データカタログ閲覧 | SMUS          |                                  |
| データSubscribe    | SMUS          | 他プロジェクトのデータを購読申請 |
| SQLクエリ実行      | SMUS / webapp |                                  |

**原則:** Lake Formation, DataZone API, S3 Access Grantsは完全に隠蔽される

### インフラ管理者の関心事

**目標:** SMUSとIdCだけを見てデータ基盤を構築できる

| 操作                           | 使用するUI  | 備考                              |
| ------------------------------ | ----------- | --------------------------------- |
| SMUSドメイン作成               | AWS Console |                                   |
| ユーザー/グループ管理          | IdC Console | SMUSへの招待はSMUS                |
| ブループリント有効化           | AWS Console | プロジェクトプロファイル設定      |
| データソース接続               | SMUS        | S3ロケーション、Glue/Redshift接続 |
| プロジェクト作成               | SMUS        |                                   |
| ETLジョブ作成                  | SMUS        |                                   |
| 運用中のバケット追加時のLF登録 | SMUS or CLI | CDK管理外のバケットが対象         |

**原則:** Lake Formation, DataZone, S3 Access Grantsの直接操作は原則不要。ただし運用中に追加されたバケットのLFロケーション登録はインフラ管理者が実施する（CDK管理外のため）。S3AG LocationはSMUSがProject Role方式で自動作成する

### 開発者の関心事

**目標:** 明確なAPIでSMUSのFGACをwebappに統合できる

| 操作                           | 実装箇所          | 意識するサービス                                                                                                               | 備考                                                                                                                                                                                                                          |
| ------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ユーザー認証                   | webapp            | Cognito                                                                                                                        |                                                                                                                                                                                                                               |
| IdC連携設定                    | CDK + コンソール  | IdC (SAML, OAuth CMA)                                                                                                          | Cognito→IdCログイン用（SAML）、RedeemAccessTokenフロー用（OAuth CMA + TTI + [`datazone:domain:access`スコープ](https://docs.aws.amazon.com/singlesignon/latest/userguide/customermanagedapps-saml2-oauth2.html#scopes-oidc)） |
| Athenaクエリ実行               | webapp            | SSO-OIDC, DataZone, Athena                                                                                                     | RedeemAccessToken → GetEnvironmentCredentials（SMUS Workgroup）                                                                                                                                                               |
| S3ファイル読み取り             | webapp            | SSO-OIDC, DataZone, [S3 Access Grants](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-grants-directory-ids.html) | RedeemAccessToken → GetEnvironmentCredentials + GetDataAccess                                                                                                                                                                 |
| LFデータレイクロケーション登録 | CDK               | Lake Formation                                                                                                                 | CDKが作成したバケットのみ。運用中の追加バケットはインフラ管理者が対応                                                                                                                                                         |
| プロジェクトロールへの権限追加 | ランブック（CLI） | IAM, S3 Access Grants                                                                                                          | CDK自動化不可（プロジェクトロールはSMUS作成時に自動生成、CDK時点でARN不明）。開発者が事前準備として実施                                                                                                                       |

**原則:**

- Lake Formationは直接操作しない（SMUSが抽象化）
- データアクセスの認証・認可フローは [data-access-control.md](./data-access-control.md) にドキュメント化
- S3 Access GrantsはGetEnvironmentCredentials経由で透過的に適用

### Platform層とInfrastructure層の責務分界

CDKが作成したリソース（S3バケット等）のLake Formationロケーションは、CDKで同時に作成する（Platform層）。S3 Access Grants LocationはSMUSがS3ロケーション追加時にProject Role方式で自動作成する。運用中にデータプロデューサーやインフラ管理者が追加するバケットやプレフィックスについては、インフラ管理者がSMUSまたはCLIで対応する（Infrastructure層）。

| リソースの起源             | LF登録                            | S3AG Location作成                                                                            | 担当ペルソナ   |
| -------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------- | -------------- |
| CDKが作成したバケット      | CDKで自動化（バケット作成と同時） | SMUSが自動作成（Project Role方式）。事前にプロジェクトロールへの権限追加が必要（ランブック） | 開発者         |
| 運用中に追加されたバケット | SMUS or CLI                       | SMUSが自動作成（Project Role方式）                                                           | インフラ管理者 |

---

## ユーザーストーリー

| #   | 操作場所  | リクエスト先                                                                           | ストーリー                                                                   | 対象ペルソナ                               | 実装       |
| --- | --------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------ | ---------- |
| 1   | SMUS      | -                                                                                      | ビジネスデータカタログを定義し、ユーザー間でデータの共有および承認が行える   | 全ペルソナ                                 | ランブック |
| 2   | SMUS      | Athena                                                                                 | FGACされたデータにSQLを介してアクセスできる                                  | データプロデューサー, データコンシューマー | ランブック |
| 3   | SMUS      | Athena                                                                                 | IdCユーザーとしてFGACが適用されたAthenaクエリを実行できる                    | データプロデューサー, データコンシューマー | ランブック |
| 4   | Webアプリ | SSO-OIDC → DataZone RedeemAccessToken → Athena                                         | FGACが適用されたAthenaに直接クエリし、表形式でデータを表示できる             | データプロデューサー, データコンシューマー | コード     |
| 5   | Webアプリ | AgentCore Runtime                                                                      | AIエージェントを呼び出し、会話できる                                         | 全ペルソナ                                 | コード     |
| 6   | Webアプリ | AgentCore Runtime → Gateway → SSO-OIDC → DataZone RedeemAccessToken → S3 Access Grants | AIエージェントがS3テキストファイルを読み取れる                               | データプロデューサー                       | コード     |
| 7   | Webアプリ | AgentCore Runtime → Gateway → Athena                                                   | AIエージェントがFGAC適用されたAthenaからデータ取得できる                     | データプロデューサー, データコンシューマー | コード     |
| 8   | Webアプリ | AgentCore Runtime → Gateway → CloudTrail Lake                                          | AIエージェントがCloudTrailログを検索できる                                   | ドメイン管理者                             | コード     |
| 9   | Webアプリ | AgentCore Runtime → Code Interpreter                                                   | AIエージェントがデータ分析結果をグラフ・チャートで可視化できる               | 全ペルソナ                                 | コード     |
| 10  | Webアプリ | AgentCore Runtime → Gateway → DataZone API                                             | AIエージェント経由でSubscription Request送信・解除ができる                   | データコンシューマー                       | コード     |
| 11  | Webアプリ | AgentCore Runtime → Gateway → DataZone API                                             | AIエージェント経由でSubscription Requestの一覧・承認・拒否・取り消しができる | データプロデューサー                       | コード     |

### 技術的制約

[data-access-control.md](./data-access-control.md) の「FGACを侵害する操作」セクションを参照。

---

## IdCプリンシパル構成

| プリンシパル              | 種別     | ペルソナ             | 役割                                                                                                                                                 | 所属グループ                                 |
| ------------------------- | -------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| dg-corp-admin             | ユーザー | ドメイン管理者       | ドメイン・認可ポリシー管理、監査ログ検索                                                                                                             | anycompany-salesmarketing, security-auditors |
| dg-data-owner             | ユーザー | データプロデューサー | 全ビジネスデータへのアクセス、データPublish、FGAC設定                                                                                                | anycompany-salesmarketing, data-producers    |
| dg-business-analyst       | ユーザー | データコンシューマー | 一般営業データへのアクセス、データSubscribe                                                                                                          | anycompany-salesmarketing, data-consumers    |
| anycompany-salesmarketing | グループ | -                    | 営業・マーケティング部門。SMUSドメインオーナーとして使用。データアクセス権限の付与には使用しない                                                     | -                                            |
| data-producers            | グループ | -                    | Policy Engine: データアクセスツール認可（athena*query, s3_read, s3_list, catalog_search, catalog_detail, subscription*\*）                           | -                                            |
| data-consumers            | グループ | -                    | Policy Engine: データアクセスツール認可（athena_query, s3_read, s3_list, catalog_search, catalog_detail, subscription_request, subscription_cancel） | -                                            |
| security-auditors         | グループ | -                    | Policy Engine: 監査ツール認可（cloudtrail_query）                                                                                                    | -                                            |

---

## デモシナリオ

### シナリオ1: データコンシューマー (営業分析)

```
「先月の店舗別売上トップ10を教えて」
→ AIエージェントがathena_query toolで retail_sales_performance を検索
→ Lake Formationが権限を評価し、結果を返却
```

### シナリオ2: データプロデューサー (機密データアクセス)

```
「営業担当者の成績評価レポートを作成して」
→ AIエージェントがathena_query toolで sales_rep_performance を検索
→ データコンシューマーには見えない機密データにアクセス可能

「機密フォルダの戦略文書を要約して」
→ AIエージェントがs3_read toolで unstructured/confidential/ を読み取り
→ S3 Access Grantsが権限を評価
```

### シナリオ3: ドメイン管理者 (セキュリティ監査)

```
「過去24時間のS3アクセスログで異常なパターンを検出して」
→ AIエージェントがcloudtrail_query toolでCloudTrail Lakeを検索
→ データプロデューサー、データコンシューマーはこのtoolを使用不可
```

### シナリオ4: データ可視化 (Code Interpreter)

```
「先月の店舗別売上をグラフで見せて」
→ AIエージェントがathena_query toolでデータ取得
→ code_interpreterでmatplotlibを使用してグラフ生成
→ SSEストリーム完了後に画像イベントとしてフロントエンドに送信
→ チャットUI内にグラフがインライン表示される
```

### シナリオ5: 権限拒否のデモ

```
データコンシューマー: 「営業担当者の成績データを見せて」
→ AIエージェントがathena_query toolを実行
→ Lake Formationが権限を拒否
→ 「このデータへのアクセス権限がありません」

データコンシューマー: 「CloudTrailログを検索して」
→ Policy Engineがtool権限を拒否
→ 「cloudtrail_query toolの使用権限がありません」
```

### シナリオ6: Subscription管理（エージェント経由）

```
データコンシューマー: 「sales_rep_performance テーブルへのアクセスをリクエストして」
→ subscription_request toolでSubscription Request送信
→ SMUS UIのOutgoing requestsにPENDINGで表示

データプロデューサー: 「受信したリクエストを確認して、承認して」
→ subscription_list_requests → subscription_approve
→ SMUS UIでAPPROVED、SubscriberがFGAC適用されたデータにアクセス可能に
```

---

## データ構成

### 構造化データ (Lake Formation + Athena)

[ワークショップ](https://catalog.us-east-1.prod.workshops.aws/workshops/06dbe60c-3a94-463e-8ac2-18c7f85788d4/en-US)のサンプルデータを使用：

| テーブル                    | 説明                                                | データプロデューサー | データコンシューマー | ドメイン管理者 |
| --------------------------- | --------------------------------------------------- | -------------------- | -------------------- | -------------- |
| store_details               | 店舗マスタ (store_id, city, state)                  | ✅ READ              | ✅ READ              | ❌             |
| retail_sales_performance    | 店舗別売上 (store_id, product_id, sales_amount)     | ✅ READ              | ✅ READ              | ❌             |
| ecommerce_customer_behavior | 顧客行動 (customer_id, purchase_amount)             | ✅ READ              | ✅ READ              | ❌             |
| sales_rep_performance       | 営業担当パフォーマンス (sales_rep_id, satisfaction) | ✅ READ              | ❌                   | ❌             |
| b2b_sales_pipeline          | B2B商談パイプライン (deal_value, pipeline_stage)    | ✅ READ              | ❌                   | ❌             |

**FGAC設定方針:**

SMUSのPublish/Subscribe機能を使用してFGACを設定する。データプロデューサーがサブスクリプション承認時に行・列フィルタを適用することで、Lake Formationの権限が自動的に設定される。

- 一般テーブル（store_details, retail_sales_performance, ecommerce_customer_behavior）: データコンシューマーにSubscribe許可
- 機密テーブル（sales_rep_performance, b2b_sales_pipeline）: データプロデューサーのみアクセス可能

**重要: SMUSでのテーブルレベルFGAC実装**

SMUSのプロジェクトメンバーシップ（Owner/Contributor）は、プロジェクトに関連付けられた**すべてのデータ**へのアクセスを許可する。テーブルレベルの細かいFGACを実現するには、**プロジェクトを分ける**必要がある。

| アプローチ               | 結果                               | 用途                                 |
| ------------------------ | ---------------------------------- | ------------------------------------ |
| プロジェクトメンバー追加 | 全テーブルにアクセス可能           | 全データへのアクセスが必要なユーザー |
| 別プロジェクト + Share   | 共有されたテーブルのみアクセス可能 | 一部テーブルのみ許可するユーザー     |

**プロジェクト構成:**

| プロジェクト           | Owner         | メンバー            | アクセス可能テーブル    |
| ---------------------- | ------------- | ------------------- | ----------------------- |
| `demo-salesdb-project` | dg-data-owner | -                   | 全5テーブル             |
| `analyst-data-access`  | dg-data-owner | dg-business-analyst | 共有された3テーブルのみ |

### 非構造化データ (S3 Access Grants)

```
s3://demo-bucket/
├── raw/sales/                   # 構造化データ（Glue External Table LOCATION）
│   ├── store_details/
│   ├── retail_sales_performance/
│   ├── ecommerce_customer_behavior/
│   ├── sales_rep_performance/
│   └── b2b_sales_pipeline/
└── unstructured/                # 非構造化データ（S3 Access Grants）
    ├── public/
    │   └── product_catalog.txt
    └── confidential/
        └── strategy_2025.txt
```

| プレフィックス             | データプロデューサー | データコンシューマー | ドメイン管理者 |
| -------------------------- | -------------------- | -------------------- | -------------- |
| unstructured/public/       | ✅ READ              | ❌                   | ❌             |
| unstructured/confidential/ | ✅ READ              | ❌                   | ❌             |

**S3 Access Grants設定:**

- データプロデューサー（dg-data-owner）に `unstructured/` 全体への READ 権限を付与
- データコンシューマーはTool権限マトリクスで `s3_read` を使用可能だが、S3 Access Grantsの権限が付与されていないためアクセスは拒否される

### CloudTrail Lake

| データストア                     | データプロデューサー | データコンシューマー | ドメイン管理者 |
| -------------------------------- | -------------------- | -------------------- | -------------- |
| CloudTrail Lake Event Data Store | ❌                   | ❌                   | ✅ READ        |

---

## Tool権限マトリクス

| Tool                       | 機能                                                         | ドメイン管理者 | データプロデューサー | データコンシューマー |
| -------------------------- | ------------------------------------------------------------ | -------------- | -------------------- | -------------------- |
| athena_query               | Lake Formation管理データへのSQLクエリ                        | ❌             | ✅                   | ✅                   |
| s3_read                    | S3 Access Grants管理ファイルの読み取り                       | ❌             | ✅                   | ✅                   |
| s3_list                    | S3プレフィックス配下のファイル一覧取得                       | ❌             | ✅                   | ✅                   |
| cloudtrail_query           | CloudTrail Lakeへのセキュリティログ検索                      | ✅             | ❌                   | ❌                   |
| catalog_search             | DataZoneカタログ検索 + Subscribe状況確認                     | ❌             | ✅                   | ✅                   |
| catalog_detail             | DataZoneカタログアセット詳細・スキーマ取得                   | ❌             | ✅                   | ✅                   |
| subscription_request       | Subscription Request送信                                     | ❌             | ✅                   | ✅                   |
| subscription_list_requests | 受信Subscription Request一覧                                 | ❌             | ✅                   | ❌                   |
| subscription_approve       | Subscription Request承認（Full access / FGAC付き）           | ❌             | ✅                   | ❌                   |
| subscription_reject        | Subscription Request拒否                                     | ❌             | ✅                   | ❌                   |
| subscription_list_filters  | アセットフィルタ一覧（FGAC付き承認の補助）                   | ❌             | ✅                   | ❌                   |
| subscription_cancel        | Subscription解除                                             | ❌             | ✅                   | ✅                   |
| subscription_revoke        | Subscription取り消し                                         | ❌             | ✅                   | ❌                   |
| code_interpreter           | Pythonコード実行・データ可視化（エージェントローカルツール） | ✅             | ✅                   | ✅                   |

**備考:** `code_interpreter`はGateway経由のMCPツールではなく、エージェントプロセス内のローカルツールとして動作する。Policy Engine（Cedarポリシー）のツール認可対象外であり、全ペルソナが使用可能。

**設計意図:**

- ドメイン管理者: セキュリティ監査専用。ビジネスデータには一切アクセスできない（職務分離）
- データプロデューサー: 全ビジネスデータにアクセス可能。監査ログにはアクセス不可
- データコンシューマー: 一般的な営業データとSubscribe済みS3ファイルにアクセス可能。機密データはS3 Access Grantsが制御。監査ログにはアクセス不可
