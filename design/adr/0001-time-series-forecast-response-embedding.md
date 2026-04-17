# ADR 0001: time_series_forecast のレスポンスに予測全点を同梱する

- Status: Accepted
- Date: 2026-04-17

## Context

`time_series_forecast` ツールの初期設計（`.kiro/specs/time-series-inference/research.md` §7.5）では、予測結果のうち `head`（先頭 5 点）と `summary`（統計量）のみを tool response に返し、予測全点は S3 バケット（artifact bucket）に保存して `artifact_s3_uri` で URI だけを返していた。Code Interpreter が S3 から直接読み取ってグラフ描画する想定だった。

本番運用時に以下の問題が顕在化した:

1. **Code Interpreter から S3 への経路が未整備**
   現在の chat-agent は System ARN (`aws.codeinterpreter.v1`) を利用しており、execution role を持たない。artifact bucket にアクセスするには Custom Code Interpreter + execution role の構築が必要。
2. **IAM 経由でのクロスユーザー漏洩リスク**
   Custom Code Interpreter の execution role は AgentCore Runtime 単位で共有されるため、`s3:GetObject` を付与するとユーザー/プロジェクト境界を越えて任意の artifact を読める穴になる。LLM が生成する任意の Python コード + プロンプトインジェクションで他ユーザーの予測データを取得する攻撃経路が成立する。
3. **`s3_read` ツールでは artifact bucket を読めない**
   `s3_read` は SMUS project credentials + S3 Access Grants 経由でしか S3 にアクセスしない。artifact bucket は SMUS 管理外のスタンドアロンバケットのため構造的にアクセス不可。

## Decision

artifact bucket 経路を廃止し、予測全点（p10 / p50 / p90 の配列）を tool response 本体に同梱する。

レスポンス構造:

```ts
{
  meta: { data_points_used, series_count, freq, prediction_length, warnings?, date_range?, last_actual_value? },
  predictions: [
    {
      item_id?: string,
      start?: string,        // ISO 8601
      freq: string,
      p10: number[],         // length === prediction_length
      p50: number[],
      p90: number[],
      summary: { p50_mean, p50_min, p50_max, p50_end, trend, uncertainty }
    }
  ]
}
```

- `head` フィールドは削除（`p50` の先頭要素で代替可能）
- `artifact_s3_uri` フィールドは削除
- artifact bucket（`Chronos2Endpoint.artifactBucket`）は CDK から削除
- 環境変数 `FORECAST_ARTIFACT_BUCKET` は削除

## Alternatives Considered

### 代替案 A: Custom Code Interpreter + execution role に artifact bucket の読み取り権限を付与

- 研究 §7.5 の当初設計を維持できる
- **却下理由**: execution role が Runtime 共有のため、同一バケット配下の他ユーザー/他プロジェクト artifact への IAM 穴になる。Session tag + IAM condition で projectId に縛る案もあるが、AgentCore が session tag を execution role に伝播する公式機能が未確認で複雑性が高い。

### 代替案 B: presigned URL を発行し、Code Interpreter から HTTP で取得

- IAM 穴を作らずに一時的な URL 配布で済む
- **却下理由**: Code Interpreter を Public network mode に切り替える必要があり（Custom ARN 必要）、外部 URL への egress を許すことで別の攻撃面が広がる。URL 漏洩時の時限的リスクも残る。

### 代替案 C (採択): 予測全点を tool response に同梱

- tool response はそのセッション・そのユーザーに閉じるため、IAM 経由のクロスユーザー漏洩経路が構造的に存在しない
- CDK / IAM / Custom Code Interpreter の追加構築が不要
- サイズ制約は初期リリース範囲（研究 §7.7: ≤100 系列 × ≤1024 点 ≈ 最大 3 MB）で AgentCore Gateway の 6 MB 上限に収まる
- LLM への生データ混入リスクは、プロンプトで「summary のみ解釈、配列は code_interpreter へ素通し」と明示して抑制

## Consequences

### Positive

- artifact bucket 関連の CDK / IAM 設定が不要になり、セキュリティ面の攻撃面が縮小
- `s3_read` と `time_series_forecast` の責務境界が明確（ユーザーデータは SMUS 経由、予測結果はセッション内に閉じる）
- Code Interpreter は response を直接読めるので S3 アクセスが不要

### Negative / Trade-offs

- 系列数が 100 を超えるスケール（研究 §7.7 で初期リリース対象外）では 6 MB 制限が再び問題化する。その時点で Asynchronous Inference への切替など再設計が必要
- LLM の tool_result context にも配列が載るため、プロンプト遵守が崩れると要約に数値が含まれるリスクが残る（プロンプトの mandatory_rules で明示）

## References

- `.kiro/specs/time-series-inference/research.md` §7.1, §7.5, §7.7
- AgentCore Code Interpreter network modes: <https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-resource-management.html>
- AgentCore Gateway quotas: <https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html>
