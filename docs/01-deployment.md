# デプロイメントガイド

このドキュメントでは、Agentic Analystのデプロイ手順を説明します。

**対象ペルソナ:** 開発者

**次のステップ:** [02-sagemaker-config.md](./02-sagemaker-config.md)

## 前提条件

### 必須

1. **AWS CLI** v2がインストールされ、認証情報が設定されていること
2. **Node.js** v20以上
3. **Docker** がインストールされ、起動していること
4. **jq** がインストールされていること

### IAM Identity Center（IdC）の制約

**重要**: このアプリケーションは**組織のIdCインスタンス**が必須です。

| 制約                                     | 理由                                                      |
| ---------------------------------------- | --------------------------------------------------------- |
| 組織IdCインスタンス必須                  | SMUS/DataZoneには組織のIdCインスタンスが必須              |
| デプロイリージョン = IdCホームリージョン | DataZoneは異なるリージョンのIdCインスタンスを参照できない |

## AWS アカウント

アプリのデプロイには2つのAWSアカウントが必要です。ドキュメントでは次のように呼称します。

- **IdC アカウント** ... IdC 組織インスタンスの管理アカウント（または委任管理者）
- **ワークロードアカウント** ... アプリのデプロイ先となるメンバーアカウント

## スタック構成

いずれもワークロードアカウントにデプロイします。

| スタック名              | リージョン       | 役割                                                       |
| ----------------------- | ---------------- | ---------------------------------------------------------- |
| `AgenticAnalystIdStore` | メインリージョン | Cognito User Pool（SAML Application作成前にデプロイ）      |
| `AgenticAnalystUsEast1` | us-east-1        | CloudFront用ACM証明書, Lambda@Edge                         |
| `AgenticAnalyst`        | メインリージョン | メインアプリ全体（VPC必須 — SMUSドメイン作成後にデプロイ） |

**注意**: SMUSドメインはコンソールで手動作成します（Phase 5参照）。

## Phase 1: IdC前提条件の設定 (IdC アカウント)

### 1.1 IdCグループ作成

1. [IAM Identity Center コンソール](https://console.aws.amazon.com/singlesignon/) を開く
2. 左メニュー「グループ」→「グループを作成」
3. 以下の4グループを作成:

| グループ名                  | 用途                                   |
| --------------------------- | -------------------------------------- |
| `anycompany-salesmarketing` | SMUSドメインオーナー（全ユーザー所属） |
| `data-producers`            | データプロデューサーの所属グループ     |
| `data-consumers`            | データコンシューマーの所属グループ     |
| `security-auditors`         | セキュリティ監査者の所属グループ       |

> [!NOTE]
> グループ名はワークロードにあわせて変更できます。変更する場合は以下のソースコードを修正してください:
>
> - `apps/cdk/lib/constructs/agent.ts` — AgentCore Policy Engineのグループ名（Cedarポリシー生成）
> - `apps/webapp/src/app/api/cloudtrail-query/route.ts` — `SECURITY_AUDITORS_GROUP` 定数

### 1.2 IdCユーザー作成

以下の3ユーザーを作成し、対応するグループに追加:

| ユーザー名            | メール                            | 役割                 | グループ                                         |
| --------------------- | --------------------------------- | -------------------- | ------------------------------------------------ |
| `dg-corp-admin`       | `dg-corp-admin@example.com`       | ドメイン管理者       | `anycompany-salesmarketing`, `security-auditors` |
| `dg-data-owner`       | `dg-data-owner@example.com`       | データプロデューサー | `anycompany-salesmarketing`, `data-producers`    |
| `dg-business-analyst` | `dg-business-analyst@example.com` | データコンシューマー | `anycompany-salesmarketing`, `data-consumers`    |

> [!NOTE]
> ユーザー名・メールアドレスはサンプルです。実際のワークロードにあわせて自由に変更できます。ユーザー名はソースコードに依存していないため、コード修正は不要です。

各ユーザーの作成手順:

1. 左メニュー「ユーザー」→「ユーザーを追加」
2. ユーザー名、メール、名、姓を入力
3. 上記テーブルに記載のグループを選択（複数選択可）
4. 「ユーザーを追加」をクリック
5. メールで届くパスワード設定リンクからパスワードを設定

## マルチ環境デプロイについて

同一アカウント・リージョンに複数の独立した環境（stg, prod等）をデプロイできます。環境名は以下の3箇所に影響します:

| 影響箇所         | 無印環境（デフォルト）                                             | stg環境の例                                                                    |
| ---------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| 環境変数ファイル | `.env.local`                                                       | `.env.local.stg`                                                               |
| `sync-env.sh`    | `./scripts/sync-env.sh`                                            | `./scripts/sync-env.sh stg`                                                    |
| CDKコマンド      | `pnpm exec cdk deploy --all`                                       | `pnpm exec cdk deploy --all -c env=stg`                                        |
| スタック名       | `AgenticAnalyst`, `AgenticAnalystIdStore`, `AgenticAnalystUsEast1` | `stg-AgenticAnalyst`, `stg-AgenticAnalystIdStore`, `stg-AgenticAnalystUsEast1` |

個別スタックをデプロイする場合はプレフィックス付きのスタック名を指定します:

```bash
# 無印環境
pnpm exec cdk deploy AgenticAnalystIdStore

# stg環境
pnpm exec cdk deploy stg-AgenticAnalystIdStore -c env=stg
```

環境名を省略すると無印環境（スタック名 `AgenticAnalyst`）として動作します。以降の手順では無印環境を前提としますが、マルチ環境の場合は上記の読み替えを行ってください。

## Phase 2: 初期設定

### 2.1 リポジトリのクローン

```bash
git clone <repository-url>
cd sample-sagemaker-agentic-analyst
```

### 2.2 AWS認証情報の設定

```bash
cp .env.credentials.example .env.credentials
# エディタで編集
```

```bash
# .env.credentials
export AWS_PROFILE=your-profile-name
export AWS_REGION=<your-region>  # IdCホームリージョンと同じリージョンを指定（例: ap-northeast-1, us-west-2）
```

### 2.3 CDK環境変数の設定

```bash
cp .env.local.example .env.local
# エディタで編集: IDC_INSTANCE_ARN を設定
```

```bash
# .env.local（Phase 2時点）
IDC_INSTANCE_ARN=arn:aws:sso:::instance/ssoins-xxxxxxxxx
IDC_ALL_USERS_GROUP=anycompany-salesmarketing
```

### 2.4 環境変数の自動解決

```bash
source .env.credentials && ./scripts/sync-env.sh
```

`IDENTITY_STORE_ID` と `IDC_PORTAL_URL` が `.env.local` に自動設定されます。

## Phase 3: IdStoreスタックのデプロイ

### 3.1 CDK Bootstrap

```bash
# モノレポルートで依存関係をインストール
pnpm install --frozen-lockfile

cd apps/cdk
source ../../.env.credentials
pnpm exec cdk bootstrap
```

### 3.2 IdStoreスタックのデプロイ

```bash
pnpm exec cdk deploy AgenticAnalystIdStore
```

出力から以下をメモ:

- `UserPoolId`
- `UserPoolClientId`
- `CognitoDomainName`

## Phase 4: IdC SAML Application作成（手動）

**IdC組織アカウント**でAWSコンソールにログインし、以下を実行:

### 4.1 SAML Applicationの作成

1. IAM Identity Center → Applications → Customer managed → Add application
2. Setup preference: 「I have an application I want to set up」を選択
3. **下にスクロール**して Application type で `SAML 2.0` を選択（デフォルトは OAuth 2.0 なので注意）→ Next
4. Display name: `Agentic Analyst`
5. Application metadata → Manually type:
   - **ACS URL**: `https://<CognitoDomainName>/saml2/idpresponse`
   - **Audience**: `urn:amazon:cognito:sp:<UserPoolId>`
6. **IAM Identity Center SAML metadata file** のURLをメモ（4.4で使用）
7. Submit

### 4.2 属性マッピングの設定

1. 作成したアプリケーション → Actions → 「Edit attribute mappings」
2. 以下を設定:

| Application attribute | Maps to         | Format        |
| --------------------- | --------------- | ------------- |
| `Subject`             | `${user:email}` | `persistent`  |
| `email`               | `${user:email}` | `unspecified` |

3. Save changes

### 4.3 グループ割り当て

1. 作成したアプリケーション → 「Assigned users and groups」→「Assign users and groups」
2. `anycompany-salesmarketing` グループを検索・選択
3. 「Assign users and groups」をクリック

> [!NOTE]
> サンプルデータの場合、全ユーザーが `anycompany-salesmarketing` に所属しているため、グループ単位の割り当てで十分です。個別ユーザーの割り当ては不要です。

### 4.4 メタデータURLの取得

4.1のステップ6でメモしたURL、または:

1. Actions → Edit configuration
2. **IAM Identity Center SAML metadata file** のURLをコピー

### 4.5 環境変数を更新

```bash
# .env.local に追加
IDC_SAML_METADATA_URL=https://portal.sso.<your-region>.amazonaws.com/saml/metadata/xxxxxxxxxx
```

### 4.6 OAuth CMA + Trusted Token Issuer設定

RedeemAccessTokenフローに必要なIdC設定を自動実行します。この設定により、Cognito ID TokenからIdC Access Token（`datazone:domain:access`スコープ付き）を取得できるようになります。

> **背景**: AIエージェント・webappがユーザー単位のプロジェクトロールを取得するには、Cognito ID Token → CreateTokenWithIAM → IdC Access Token → RedeemAccessToken → GetEnvironmentCredentials というフローが必要です。このフローにはOAuth CMA + TTI + `datazone:domain:access` スコープの設定が前提条件です。詳細は [data-access-control.md](../design/data-access-control.md) を参照。

```bash
source .env.credentials && ./scripts/setup-idc-tip.sh
```

スクリプトは以下を自動実行します（再実行安全）:

1. CfnOutputからCognito User Pool ID / Client IDを取得
2. Trusted Token Issuer (TTI) を作成
3. OAuth Customer Managed Application (CMA) を作成（`Visibility: DISABLED`）
4. JWT Bearer Grant設定（TTI + aud claimの紐付け）
5. アクセススコープ設定（`datazone:domain:access`, `sso:account:access`）
6. `anycompany-salesmarketing` グループをCMAに割り当て
7. `.env.local` に `IDC_APPLICATION_ARN` を書き込み

> [!NOTE]
> マルチ環境の場合: `source .env.credentials && ./scripts/setup-idc-tip.sh stg`

## Phase 5: SMUSドメイン作成（Quick Setup）

**重要**: SMUSドメインはコンソールで手動作成します。

### 5.1 SageMaker ドメインの作成

1. Amazon SageMaker コンソール を開く
2. 「Create Domain」をクリック
3. 「Quick setup」を選択
4. Quick Setup 設定を展開し、ドメイン名を `Corporate` など任意の名前に変更
5. 「VPC を選択」から作成済みのVPCを選択
6. サブネット: 異なるAZのプライベートサブネットを2つ以上選択
7. 「続行」をクリック
8. IAM アイデンティティーセンターユーザー画面で、ドメイン管理者のメールアドレスを検索・選択（例: `dg-corp-admin`）
9. 「ドメインを作成」をクリック
10. ドメイン作成完了まで約10分待機

### 5.3 ドメインIDの取得

ドメイン作成完了後:

1. 作成したドメインをクリック
2. 「Domain details」から **Domain ID**: `dzd-xxxxxxxxx` をメモ

### 5.4 環境変数を更新

```bash
# .env.local に追加
SMUS_DOMAIN_ID=dzd-xxxxxxxxx
```

### 5.5 環境変数の自動解決

```bash
source .env.credentials && ./scripts/sync-env.sh
```

`IDENTITY_STORE_ID`, `IDC_PORTAL_URL` が `.env.local` に自動設定されます。

### 5.6 ユーザーアクセス設定

Quick Setupで作成したドメインは「Require assignments」（割り当て必須）で設定されます。アクセスが必要なユーザー/グループを追加してください。

1. ドメイン詳細ページ → 「User management」タブ
2. 「Add users and groups」をクリック
3. IdCグループ `anycompany-salesmarketing` を追加

> [!NOTE]
> Root domain ownerを追加する場合は「User management」→「Root domain owners」→「Add」から設定できます。Quick Setupで指定したユーザーが既にオーナーになっているため、通常は追加不要です。

## Phase 6: 全スタックデプロイ

### 6.1 Bedrockモデルアクセスの有効化

CDKデプロイ前に、使用するBedrockモデルの利用規約（EULA）に同意する必要があります。未同意の場合、エージェント実行時に`AccessDeniedException`が発生します。

1. [Amazon Bedrock コンソール](https://console.aws.amazon.com/bedrock/) を開く
2. 左メニュー「Model access」→「Manage model access」
3. 使用するモデル（例: Claude Sonnet 4.6）にチェックを入れ、「Request model access」
4. EULAに同意し、アクセスが「Access granted」になるまで待機
5. 「Playground」からモデルを一度呼び出して動作確認（推奨）

> [!NOTE]
> Cross-region inference（`jp.anthropic.claude-sonnet-4-6`等のプレフィックス付きモデルID）を使用する場合でも、ソースリージョンでのモデルアクセス有効化が必要です。

### 6.2 CloudWatch Transaction Searchの有効化

GatewayトレースをCloudWatch Logs（`aws/spans`）で確認するために必要です。アカウント全体で一度だけ実行すれば十分です。

1. [CloudWatch コンソール](https://console.aws.amazon.com/cloudwatch/) を開く
2. 左メニュー「Application Signals」→「Transaction Search」
3. 「Enable Transaction Search」をクリック
4. スパンの構造化ログ取り込みにチェックを入れ、インデックス率を設定（1%で無料枠内）

> [!NOTE]
> 既にTransaction Searchが有効な場合、この手順はスキップできます。

### 6.3 デプロイ実行

```bash
source .env.credentials

# 環境変数の自動解決（CDK Outputs + AWS API）
./scripts/sync-env.sh

# 全スタックデプロイ
cd apps/cdk
pnpm exec cdk deploy --all -y

# デプロイ後にwebapp環境変数を再同期
cd ../..
./scripts/sync-env.sh
```

## Phase 7: IdCポータルからのワンクリックログイン設定（推奨）

IdCポータル（`awsapps.com/start`）のアプリケーション一覧から、直接このアプリにログインできるようにする設定です。設定しなくても、アプリのサインインページ（`/sign-in`）からのログインは正常に動作します。

Phase 4.1で作成したSAML Applicationの設定を更新します:

1. Phase 6のデプロイ出力から `FrontendDomainName` の値を確認
2. IdC → Applications → 「Agentic Analyst」→ Actions → Edit configuration
3. 「Relay state」に以下を設定:

```
identity_provider=IdC&client_id=<USER_POOL_CLIENT_ID>&redirect_uri=<FRONTEND_URL>/api/auth/sign-in-callback&response_type=code&scope=openid+email+phone
```

## 2回目以降のデプロイ

```bash
cd apps/cdk
source ../../.env.credentials
pnpm exec cdk deploy --all
```

## クリーンアップ

```bash
# CDKスタックの削除
cd apps/cdk
pnpm exec cdk destroy --all --force
```

**注意**:

- DataZoneドメインはコンソールから手動で削除する必要があります
- IdC SAML Applicationは手動で削除が必要です

## トラブルシューティング

### Bedrockモデルアクセスエラー

| エラーメッセージ                      | 原因                 | 解決策                                                                     |
| ------------------------------------- | -------------------- | -------------------------------------------------------------------------- |
| `AccessDeniedException` (InvokeModel) | モデルのEULAに未同意 | Bedrockコンソール → Model access でモデルアクセスを有効化（Phase 6.1参照） |

### GetEnvironmentCredentials関連のエラー

| エラーメッセージ                            | 原因                           | 解決策                               |
| ------------------------------------------- | ------------------------------ | ------------------------------------ |
| `User is not a member of this project`      | メンバーシップ検証で拒否       | SMUSでユーザーをプロジェクトに追加   |
| `Athena workgroup not found in environment` | 環境のプロビジョニングが未完了 | SMUSコンソールで環境ステータスを確認 |

### SAML認証後にCognitoでエラー

**原因**: 属性マッピングの不一致

**確認**:

1. IdC SAML Application → Attribute mappings
2. `email` が `${user:email}` にマッピングされているか確認

## 次のステップ

[02-sagemaker-config.md](./02-sagemaker-config.md) に進み、SMUS設定を行ってください。
