# 時系列予測機能（Chronos-2）

`enableTimeSeries=true` でデプロイすると、SageMaker JumpStart の Chronos-2 モデルを常時稼働させ、AIエージェントが `time_series_forecast` ツールを通じて時系列データから将来値を予測できるようになります。

## ユースケース

- 「製品Aの来月30日間の売上を予測して」
- 「カテゴリ別に今後3ヶ月の販売数量を予測して」
- 「最近のトレンドをもとに来週の在庫需要を予測して」

LLM（Claude）は `catalog_search` → `catalog_detail` でテーブルを特定し、`time_series_forecast` を呼び出します。ツール呼び出しの裏側では Lambda が:

1. Athena SQL を実行（`ts` / `y` / `item_id` カラムを抽出）
2. 欠損タイムスタンプを `fill_missing_policy` に従って補完
3. SageMaker Chronos-2 エンドポイントに InvokeEndpoint
4. 統計サマリと予測全点（p10 / p50 / p90 配列）を含むレスポンスを返却

レスポンスに含まれる full 配列（p10 / p50 / p90）は Code Interpreter での可視化に使われます。LLM 自身は `summary` の統計量とトレンド/不確実性のみを解釈し、配列は Code Interpreter へ素通しする運用です。

詳細な設計判断の背景は `.kiro/specs/time-series-inference/research.md` を参照。

## 有効化と無効化

**有効化（opt-in）:**

`.env.local.<env>` に以下を追記:

```bash
ENABLE_TIME_SERIES=true
```

その後、通常どおりデプロイ:

```bash
cd apps/cdk
source ../../.env.credentials
pnpm exec cdk deploy stg-AgenticAnalyst -c env=stg
```

**無効化:** `ENABLE_TIME_SERIES` を `.env.local.<env>` から削除（または `false` に設定）して再デプロイすると、エンドポイント・Lambda・Gateway Target が削除されます。

無印環境の場合は `-c env=stg` を省略します。

## インスタンスタイプとコスト

デフォルトは `ml.c7i.xlarge`（ap-northeast-1 で ~$178/月 24/7）。c5.xlarge より中央値で約 12% 低レイテンシ、コスト差は +3.4%。単系列・数十系列程度の規模なら CPU で十分です。高負荷が見込まれる場合は `chronos2-endpoint.ts` の `instanceType` プロパティで変更してください。

## スコープ外

初期リリースでは以下は未対応（リサーチ §7.7 参照）:

- 多変量予測（target が 2次元）
- 共変量（past/future_covariates）
- `cross_learning=true`
- 100 系列超のバッチ予測（AgentCore Gateway の 6MB 制限に接近する）

## データ要件

`time_series_forecast` ツールに渡す SQL は以下の規約に従うこと:

- タイムスタンプ列は `... AS ts` でエイリアス
- 予測対象の数値列は `... AS y` でエイリアス
- 複数系列予測時のみ、系列識別子列を `... AS item_id` でエイリアス

観測数の目安:

| freq | 推奨最低件数 | 警告閾値 | エラー閾値 |
| ---- | ------------ | -------- | ---------- |
| 1h   | 168（1週間） | < 30     | < 5        |
| D    | 90（3ヶ月）  | < 30     | < 5        |
| W    | 52（1年）    | < 30     | < 5        |
| MS   | 24（2年）    | < 30     | < 5        |

`prediction_length` は過去観測数の 50% 以下に収めることを推奨。

## 運用

- エンドポイント状態: `aws sagemaker describe-endpoint --endpoint-name <env>-agentic-analyst-chronos2-<suffix> --region ap-northeast-1`
- Lambda ログ: CloudWatch Logs の `*-AgentTimeSeriesForecastLogs*` ロググループ
- エンドポイントログ: `/aws/sagemaker/Endpoints/<env>-agentic-analyst-chronos2`
