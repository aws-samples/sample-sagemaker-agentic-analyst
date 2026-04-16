'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, Play, AlertCircle, TableIcon } from 'lucide-react';

type QueryResult = {
  columns: string[];
  rows: Record<string, string>[];
};

const SAMPLE_QUERIES = [
  {
    label: 'データアクセスユーザー一覧（24h）',
    sql: `SELECT DISTINCT userIdentity.arn as user_arn, eventSource, eventName, eventTime
FROM <EVENT_DATA_STORE_ID>
WHERE eventTime > date_add('hour', -24, current_timestamp)
  AND eventSource IN ('datazone.amazonaws.com', 'athena.amazonaws.com', 'lakeformation.amazonaws.com')
  AND eventName IN ('GetEnvironmentCredentials', 'StartQueryExecution', 'GetTemporaryGlueTableCredentials')
ORDER BY eventTime DESC
LIMIT 50`,
  },
  {
    label: 'Athenaクエリ実行履歴（24h）',
    sql: `SELECT eventTime, userIdentity.arn as user_arn, requestParameters
FROM <EVENT_DATA_STORE_ID>
WHERE eventTime > date_add('hour', -24, current_timestamp)
  AND eventSource = 'athena.amazonaws.com'
  AND eventName = 'StartQueryExecution'
ORDER BY eventTime DESC
LIMIT 50`,
  },
  {
    label: 'アクセス拒否イベント（24h）',
    sql: `SELECT eventTime, eventSource, eventName, userIdentity.arn as user_arn, errorCode, errorMessage
FROM <EVENT_DATA_STORE_ID>
WHERE eventTime > date_add('hour', -24, current_timestamp)
  AND errorCode IN ('AccessDenied', 'AccessDeniedException', 'UnauthorizedAccess')
ORDER BY eventTime DESC
LIMIT 50`,
  },
  {
    label: 'GetEnvironmentCredentials（7日）',
    sql: `SELECT eventTime, userIdentity.arn as user_arn, errorCode
FROM <EVENT_DATA_STORE_ID>
WHERE eventTime > date_add('day', -7, current_timestamp)
  AND eventSource = 'datazone.amazonaws.com'
  AND eventName = 'GetEnvironmentCredentials'
ORDER BY eventTime DESC
LIMIT 50`,
  },
];

export function CloudTrailQueryInterface() {
  const [sql, setSql] = useState('');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [eventDataStoreId, setEventDataStoreId] = useState('<EVENT_DATA_STORE_ID>');

  useEffect(() => {
    fetch('/api/cloudtrail-query')
      .then((r) => r.json())
      .then((d) => {
        if (d.eventDataStoreId) setEventDataStoreId(d.eventDataStoreId);
      })
      .catch(() => {});
  }, []);

  const fillQuery = (template: string) => setSql(template.replace(/<EVENT_DATA_STORE_ID>/g, eventDataStoreId));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sql.trim() || isLoading) return;

    setIsLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch('/api/cloudtrail-query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql }),
      });

      const data = await res.json();

      if (!res.ok || data.error) {
        throw new Error(data.error || 'クエリ実行に失敗しました');
      }

      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'エラーが発生しました');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <div className="flex flex-col gap-4 p-4 max-w-6xl mx-auto w-full flex-shrink-0">
        <div className="flex flex-wrap gap-1.5">
          {SAMPLE_QUERIES.map((q) => (
            <button
              key={q.label}
              onClick={() => fillQuery(q.sql)}
              className="px-2.5 py-1 text-xs rounded-full border border-border text-muted-foreground hover:text-foreground hover:border-primary/30 hover:bg-primary/5 transition-colors font-mono"
            >
              {q.label}
            </button>
          ))}
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="relative">
            <Textarea
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              placeholder={`SELECT eventTime, userIdentity.arn as user_arn, eventSource, eventName\nFROM <EVENT_DATA_STORE_ID>\nWHERE eventTime > date_add('hour', -24, current_timestamp)\n  AND eventSource = 'datazone.amazonaws.com'\nORDER BY eventTime DESC\nLIMIT 10`}
              className="font-mono text-sm min-h-[120px] rounded-xl border-border/60 focus-visible:ring-primary/30 pr-20"
              disabled={isLoading}
            />
            <Button
              type="submit"
              size="sm"
              disabled={isLoading || !sql.trim()}
              className="absolute bottom-3 right-3 rounded-lg gap-1.5"
            >
              {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              実行
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            <code className="font-mono">&lt;EVENT_DATA_STORE_ID&gt;</code>{' '}
            はそのまま使用できます。実行時に自動で置換されます。
          </p>
        </form>

        {error && (
          <div className="flex items-start gap-2 p-3 bg-destructive/5 text-destructive rounded-xl text-sm">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            {error}
          </div>
        )}
      </div>

      {result && (
        <div className="flex flex-col min-h-0 flex-1 mx-4 mb-4 max-w-6xl w-full self-center border rounded-xl">
          <div className="flex items-center gap-2 px-4 py-2.5 bg-secondary/50 border-b text-xs text-muted-foreground flex-shrink-0">
            <TableIcon className="w-3.5 h-3.5" />
            {result.rows.length} 件の結果
          </div>
          <div className="flex-1 min-h-0 overflow-auto">
            <table className="w-full caption-bottom text-sm">
              <thead className="[&_tr]:border-b">
                <tr className="border-b transition-colors hover:bg-transparent">
                  {result.columns.map((col) => (
                    <th
                      key={col}
                      className="h-10 px-2 text-left align-middle font-medium text-muted-foreground text-xs whitespace-nowrap"
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="[&_tr:last-child]:border-0">
                {result.rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={result.columns.length}
                      className="text-center text-muted-foreground py-8 p-2 align-middle"
                    >
                      結果がありません
                    </td>
                  </tr>
                ) : (
                  result.rows.map((row, i) => (
                    <tr key={i} className="border-b transition-colors hover:bg-muted/50">
                      {result.columns.map((col) => (
                        <td key={col} className="p-2 align-middle font-mono text-xs whitespace-nowrap">
                          {row[col]}
                        </td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
