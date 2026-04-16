# 開発ガイド

このドキュメントは、Agentic Analystプロジェクトの標準開発手順、デバッグ方法を定義します。

## ドキュメント管理方針

### 記述内容の指針

| 文書種別           | 記述方針            | 内容                                                                           | 場所      |
| ------------------ | ------------------- | ------------------------------------------------------------------------------ | --------- |
| **README.md**      | What + How to start | プロジェクト概要と導入手順 (See [Make a README](https://www.makeareadme.com/)) | `/`       |
| **AGENTS.md**      | How + What for      | 貢献方法と開発手順                                                             | `/`       |
| **API docs**       | What + When         | APIの機能と使用タイミング                                                      | `docs/`   |
| **User guide**     | How + What for      | 使用方法と用途                                                                 | `docs/`   |
| **Design Docs**    | Why + What if       | 設計判断と代替案の検討                                                         | `design/` |
| **ADR**            | Why + When          | アーキテクチャ決定の理由と時期                                                 | `design/` |
| **コミットログ**   | Why                 | 変更の理由と背景                                                               | -         |
| **PRテンプレート** | What + Why          | 変更内容と理由                                                                 | -         |
| **コードコメント** | Why not             | 非自明な実装の判断理由                                                         | -         |

### どこに何を書くか

| 場所        | 判断基準                                 | 例                                              | 対象読者               |
| ----------- | ---------------------------------------- | ----------------------------------------------- | ---------------------- |
| `AGENTS.md` | 「こうしなさい」（開発規約、手順）       | 「pnpmを使う」「pnpm run test:unit の実行方法」 | AIエージェント、開発者 |
| `design/`   | 「こうなっている理由」（設計判断、仕様） | 「AgentCoreを使う理由」「状態遷移モデル」       | 開発者                 |
| `docs/`     | 「こう使う」（ユーザー向け手順）         | 操作マニュアル、API仕様と使うべきタイミング     | ユーザー               |

### 重要な原則

1. **永続化の責任**: `.kiro/specs/` と `.aidlc-docs/` は開発時の一時的なファイル。重要な設計判断や仕様は必ず `design/` に永続化すること
2. **ADRの記録**: 複数の選択肢を検討した上で技術的判断を行った場合は `design/adr/` にArchitecture Decision Recordとして記録
3. **ユーザーガイドの作成**: 外部公開APIの追加や、複雑な手順を要する操作を実装した場合は `docs/` にガイドを作成
4. **設計書の更新**: データモデル変更時は `design/core-entities.md`、アーキテクチャ変更時は `design/data-access-control.md` を更新
5. **図はMermaidで記述**: フローチャート、ER図、状態遷移図などはMermaid記法を使用
6. **コードから読み取れる情報は書かない**: 実装詳細はコードを参照

## コマンド

```bash
# 依存関係のインストール（モノレポルートで実行）
pnpm install --frozen-lockfile

# 個別パッケージ
cd apps/webapp && pnpm run build
cd apps/webapp && pnpm run check        # lint + format
cd apps/webapp && pnpm run test:unit

# cdk
cd apps/cdk && pnpm exec cdk deploy --all --no-rollback
cd apps/cdk && pnpm exec cdk diff

# 全パッケージ一括
pnpm -r run check test:unit

# 統合テスト（AWS認証情報が必要）
source .env.credentials && pnpm run test:integ

# 開発サーバー（webapp + chat-agent）
./scripts/dev-server.sh start
./scripts/dev-server.sh stop
./scripts/dev-server.sh status
```

## 開発ガイド

### 認証

サーバーサイドのミューテーションはすべて `authActionClient`（`lib/safe-action.ts`）を経由する。Amplifyサーバーサイド認証でCognitoセッションを検証し、`ctx.userId` を注入する。

`proxy.ts` がルート保護を担当（未認証ユーザーを `/sign-in` にリダイレクト）。Lambda handler内で実行される。このプロジェクトに `middleware.ts` は存在しない。

### フロントエンド（Next.js）

状態管理:

- サーバーデータ → SWR（Server Componentの `fallback` で初期データ、API Routeは再検証用のみ）
- 通知・プリファレンス → Zustand（`persist` + `skipHydration`）
- フォーム → React Hook Form + next-safe-action
- 一時的なUI状態 → `useState`

データ更新:

- ミューテーション後は `mutate()` でSWRキャッシュを更新。`revalidatePath()` や `router.refresh()` は使わない
- Server Actionは副作用のみ。データを返さない — SWR経由で取得
- エラー通知は `handleError()`（`lib/error-handler.ts`）を使用。`toast.error()` を直接呼ばない

### Lambda環境

webappはCloudFront経由のLambda上でLambda Web Adapter（レスポンスストリーミング）で動作。`next.config.ts` は `output: 'standalone'`。CDKが自動的にすべてのDockerイメージをビルドする — 事前ビルドやnpm installは不要。

### コード品質ツール

- **oxlint**: lint + 型チェック（`--type-check` で `tsc --noEmit` を代替）
- **oxfmt**: フォーマッター（Prettier互換）
- 設定ファイル: `oxlintrc.json`（ルート）、`.oxfmtrc.json`（ルート）
- pre-commitフックのoxlintは `--type-check` なし（lint-staged非互換）。型チェックはCI（`lint:ci`）で担保
- `no-restricted-syntax`（`process.env` 直接参照の禁止）は oxlint v1.56.0 時点で未サポート。設定は記述済みだが無効。開発者の規約遵守とコードレビューで担保

### 共有型

`packages/shared-types/`（`@agentic-analyst/shared-types`）— パッケージ間で共有する型: SSEイベント、Gateway Tool event/response型、SQSメッセージ、S3ファイル構造。

以下のいずれかに該当する場合、共有型として定義する:

1. **SQSメッセージ**: ジョブ間でキューを介してやり取りするデータ
2. **S3ファイル構造**: 複数のジョブがS3経由で共有するJSONファイルの構造
3. **Enum**: DBスキーマで定義され、複数言語で参照されるもの
4. **SSEイベント**: chat-agent ↔ webapp間のストリーミングプロトコル型
5. **Gateway Tool型**: GatewayToolEvent/Response等、複数Lambdaで共通の型

## テスト

| カテゴリ | 目的                   | 外部依存                           | コマンド                                         |
| -------- | ---------------------- | ---------------------------------- | ------------------------------------------------ |
| unit     | 振る舞いテスト         | なし（すべてモック）               | `pnpm run test:unit`                             |
| integ    | 外部API連携テスト      | Bedrock, AgentCore（ステートレス） | `source .env.credentials && pnpm run test:integ` |
| e2e      | パイプライン全体テスト | Bedrock, AgentCore（ステートフル） | `playwright-cli`（アドホック、`.spec.ts` 不要）  |

テストファイルは各アプリ配下に配置: `tests/unit/`, `tests/integration/`

## 運用

### AWS認証情報

`.env.credentials` に `AWS_PROFILE` を設定し、スクリプト実行時に `source` する。

```bash
# .env.credentials
AWS_PROFILE=<your-aws-profile>
```

#### Identity Center (SSO) を使用する場合

```ini
# ~/.aws/config
[profile <your-aws-profile>]
sso_session = my-sso
sso_account_id = <your-account-id>
sso_role_name = <SSOで割り当てられたロール名>
region = us-west-2

[sso-session my-sso]
sso_start_url = https://<your-sso-instance>.awsapps.com/start
sso_region = us-east-1
sso_registration_scopes = sso:account:access
```

#### IAM Userからスイッチロールする場合

```ini
# ~/.aws/config
[profile <your-aws-profile>]
role_arn = arn:aws:iam::<account-id>:role/<role-name>
source_profile = <IAM Userのプロファイル名>
region = us-west-2
```

```bash
source .env.credentials && ./scripts/sync-env.sh
```

### データベースマイグレーション

デプロイ時にCDK Triggerで自動実行される。手動実行が必要な場合:

```bash
pnpm --filter @repo/db run migrate
```

### マルチ環境デプロイ

```bash
# stg環境の例
source .env.credentials && ./scripts/sync-env.sh stg
cd apps/cdk && pnpm exec cdk deploy --all -c env=stg --no-rollback
```

- `sync-env.sh` の引数 → `.env.local.stg` を読み書き
- CDK `-c env=stg` → スタック名に `stg-` プレフィックス
- 環境名省略で無印環境（`AgenticAnalyst`）

### CloudWatch Logs

リージョン: ap-northeast-1。スタック名: AgenticAnalyst, AgenticAnalystIdStore, AgenticAnalystUsEast1。マルチ環境の場合 `AgenticAnalyst` → `{env}-AgenticAnalyst` に読み替え。

| Lambda          | ロググループ                                    |
| --------------- | ----------------------------------------------- |
| Webapp          | `AgenticAnalyst-WebappLogs*`                    |
| DataAccess      | `AgenticAnalyst-AgentDataAccessLogs*`           |
| DataCatalog     | `AgenticAnalyst-AgentDataCatalogLogs*`          |
| CloudtrailQuery | `AgenticAnalyst-AgentCloudtrailQueryLogs*`      |
| PolicyEngine    | `AgenticAnalyst-AgentPolicyEngineProviderLogs*` |
| PreTokenGen     | `AgenticAnalystIdStore-PreTokenGenLogs*`        |

## 規約

- UIコンポーネント: [shadcn/ui](https://ui.shadcn.com/) を使用。インストール: `cd apps/webapp && pnpm dlx shadcn@latest add <component-name>`
  - shadcn/uiにないコンポーネントを手書きする場合: モーダル・ダイアログはESCキー・フォーカストラップ・aria-label必須、インタラクティブ要素はキーボード操作対応（Enter/Space）、フォーム要素はラベルとの関連付け（htmlFor/id）
- ログ: Lambda Powertools構造化ログ（`@aws-lambda-powertools/logger`）を使用。Lambdaコードで `console.log/error/warn` 禁止
  - テスト・スクリプトファイル（`tests/**`, `scripts/**`）では標準ログも許容
- ERRORは手動介入が必要な処理不能障害のみ。リトライ可能なエラーはWARN
- 依存関係: esbuildとNext.jsがすべてバンドルするため、Lambdaランタイムでネイティブバイナリが必要なパッケージのみ `dependencies`。それ以外は `devDependencies`

### Lambda Powertools ログ実装パターン

```typescript
// handler.tsでLoggerを作成・エクスポート
import { Logger } from '@aws-lambda-powertools/logger';
export const logger = new Logger({ serviceName: 'job-name' });

// サブモジュールでインポート
import { logger } from '../handler';
logger.info('Processing', { featureId });
```

### 自動化できない手動設定

以下はAWSサービスの制約により自動化できず、手動設定が必須:

- IdCユーザー/グループ作成（パスワードリセットの手動ステップが必要）
- IdC SAML Application（`create-application` APIはOAuth 2.0のみ対応、SAML 2.0非対応）
- SubscriberプロジェクトのSubscription Target作成（Data ConsumerプロファイルにLakehouse環境を追加できないため）
- DataZoneドメイン削除（APIでは `User is not permitted to perform operation: DeleteProject` エラーが発生する場合がある。コンソールから手動削除が必要）
- SMUS SSO認証はポップアップウィンドウベースのため、headlessブラウザ（Playwright等）での自動操作ができない

## AIエージェントが遵守すべきこと

- コード変更後、変更したパッケージで `pnpm run check && pnpm run test:unit` を実行。`test:unit` スクリプトがなければ `pnpm run check` のみ
- `'use client'` コンポーネント変更後は `apps/webapp` で `pnpm run build` も実行（クライアント/サーバー境界の検証）
- フロントエンド変更後は `playwright-cli` で動作確認。開発サーバーのポートは **3012**。`.spec.ts` ファイルは明示的な E2E テスト作成指示がない限り作成しない

## 禁止事項

- `npm` / `npx` を使わない。pnpmプロジェクト
- Lambdaコードで `console.log/error/warn` を使わない。Lambda Powertools Loggerを使用
- ログメッセージにテンプレートリテラルを使わない。構造化ログのキーワード引数を使用（`logger.info('Processing', { id })` ✅ / `logger.info(\`Processing ${id}\`)` ❌）
- `revalidatePath()` / `router.refresh()` を使わない — SWRがキャッシュを管理
- `toast.error()` を直接呼ばない — `handleError()` を使用
- サーバーデータをZustandに保存しない — SWRを使用
- Zustand persistで `skipHydration: false` を使わない（ハイドレーションエラーの原因）
