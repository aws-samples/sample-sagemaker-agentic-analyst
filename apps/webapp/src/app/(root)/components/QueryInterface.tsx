'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Loader2, Play, AlertCircle, TableIcon } from 'lucide-react';
import { ProjectRequiredPlaceholder } from '@/components/ProjectRequiredPlaceholder';

type QueryResult = {
  columns: string[];
  rows: Record<string, string>[];
};

export function QueryInterface({ projectId }: { projectId: string }) {
  const [sql, setSql] = useState('');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sql.trim() || isLoading) return;

    setIsLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, projectId }),
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

  const SAMPLE_QUERIES = [
    { label: '店舗一覧', sql: 'SELECT * FROM store_details LIMIT 5' },
    { label: '売上実績', sql: 'SELECT * FROM retail_sales_performance LIMIT 5' },
    { label: '顧客行動', sql: 'SELECT * FROM ecommerce_customer_behavior LIMIT 5' },
    { label: '営業成績（機密）', sql: 'SELECT * FROM sales_rep_performance LIMIT 5' },
    { label: 'B2Bパイプライン（機密）', sql: 'SELECT * FROM b2b_sales_pipeline LIMIT 5' },
  ];

  if (!projectId) return <ProjectRequiredPlaceholder />;

  return (
    <div className="flex flex-col gap-4 p-4 max-w-6xl mx-auto">
      <div className="flex flex-wrap gap-1.5">
        {SAMPLE_QUERIES.map((q) => (
          <button
            key={q.label}
            onClick={() => setSql(q.sql)}
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
            placeholder="SELECT * FROM your_table LIMIT 10"
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
      </form>

      {error && (
        <div className="flex items-start gap-2 p-3 bg-destructive/5 text-destructive rounded-xl text-sm">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {result && (
        <div className="border rounded-xl overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2.5 bg-secondary/50 border-b text-xs text-muted-foreground">
            <TableIcon className="w-3.5 h-3.5" />
            {result.rows.length} 件の結果
          </div>
          <div className="overflow-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  {result.columns.map((col) => (
                    <TableHead key={col} className="text-xs font-medium">
                      {col}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={result.columns.length} className="text-center text-muted-foreground py-8">
                      結果がありません
                    </TableCell>
                  </TableRow>
                ) : (
                  result.rows.map((row, i) => (
                    <TableRow key={i}>
                      {result.columns.map((col) => (
                        <TableCell key={col} className="text-sm">
                          {row[col]}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
