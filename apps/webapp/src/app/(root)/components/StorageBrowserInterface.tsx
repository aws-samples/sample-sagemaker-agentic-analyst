'use client';

import { useMemo, useEffect, useState } from 'react';
import '@aws-amplify/ui-react-storage/styles.css';
import { createManagedAuthAdapter, createStorageBrowser } from '@aws-amplify/ui-react-storage/browser';
import { AlertCircle, Loader2 } from 'lucide-react';

type CredentialsResult = {
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: Date };
  accountId: string;
  region: string;
};

// クライアントサイドキャッシュ: environmentIdごとに認証情報をキャッシュし、期限5分前に再取得
const credentialsCache = new Map<string, CredentialsResult & { expiresAt: number }>();
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

async function fetchCredentials(projectId: string): Promise<CredentialsResult> {
  const cached = credentialsCache.get(projectId);
  if (cached && cached.expiresAt > Date.now() + REFRESH_MARGIN_MS) {
    const { expiresAt: _, ...rest } = cached;
    return rest;
  }
  const res = await fetch(`/api/s3-credentials?projectId=${encodeURIComponent(projectId)}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `認証情報の取得に失敗しました (${res.status})`);
  }
  const data = await res.json();
  const expiration = data.expiration ? new Date(data.expiration) : new Date(Date.now() + 3600_000);
  const result: CredentialsResult = {
    credentials: {
      accessKeyId: data.accessKeyId,
      secretAccessKey: data.secretAccessKey,
      sessionToken: data.sessionToken,
      expiration,
    },
    accountId: data.accountId ?? '',
    region: data.region ?? 'ap-northeast-1',
  };
  credentialsCache.set(projectId, { ...result, expiresAt: expiration.getTime() });
  return result;
}

export function StorageBrowserInterface({ projectId }: { projectId: string }) {
  const [ready, setReady] = useState(false);
  const [credError, setCredError] = useState<string | null>(null);
  const [config, setConfig] = useState<{ accountId: string; region: string } | null>(null);

  // マウント時に認証情報をプリフェッチしてキャッシュに乗せる
  useEffect(() => {
    if (!projectId) return;
    setReady(false);
    setCredError(null);
    fetchCredentials(projectId)
      .then((result) => {
        setConfig({ accountId: result.accountId, region: result.region });
        setReady(true);
      })
      .catch((e) => setCredError(e instanceof Error ? e.message : 'エラーが発生しました'));
  }, [projectId]);

  const StorageBrowser = useMemo(() => {
    if (!projectId || !config) return null;

    const { StorageBrowser } = createStorageBrowser({
      config: createManagedAuthAdapter({
        region: config.region,
        accountId: config.accountId,
        credentialsProvider: () => fetchCredentials(projectId).then((r) => r),
        registerAuthListener: () => {},
      }),
    });

    return StorageBrowser;
  }, [projectId, config]);

  if (!projectId) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
        ヘッダーでプロジェクト環境を選択してください
      </div>
    );
  }

  if (credError) {
    return (
      <div className="flex items-start gap-2 p-4 text-destructive text-sm">
        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
        {credError}
      </div>
    );
  }

  if (!ready || !StorageBrowser) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground gap-3">
        <Loader2 className="w-6 h-6 animate-spin" />
        <span className="text-base">S3アクセス権限を確認中...</span>
      </div>
    );
  }

  return (
    <div className="p-4 max-w-6xl mx-auto">
      <StorageBrowser />
    </div>
  );
}
