'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import useSWR from 'swr';
import { Sidebar, type SessionItem } from '@/components/Sidebar';
import type { ProjectInfo } from '@/app/api/projects/route';
import { ProjectProvider } from '@/lib/project-context';
import { useProjectStore } from '@/stores/project-store';

const fetcher = (url: string) => fetch(url).then((r) => (r.ok ? r.json() : []));

export function AppShell({ email, children }: { email: string; children: React.ReactNode }) {
  const { projectId, setProjectId } = useProjectStore();

  useEffect(() => {
    void useProjectStore.persist.rehydrate();
  }, []);
  const router = useRouter();
  const pathname = usePathname();

  const { data: sessions = [], mutate: mutateSessions } = useSWR<SessionItem[]>('/api/sessions', fetcher);

  const { data: projects = null } = useSWR<ProjectInfo[]>('/api/projects', fetcher);

  // 永続化されたprojectIdがプロジェクト一覧に存在しない場合、未選択にリセット
  useEffect(() => {
    if (projects && projectId && !projects.some((p) => p.projectId === projectId)) {
      setProjectId('');
    }
  }, [projects, projectId, setProjectId]);

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      // 楽観的更新（revalidate: false でポーリングによる復活を防止）
      await mutateSessions((prev) => prev?.filter((s) => s.sessionId !== sessionId), { revalidate: false });
      if (pathname === `/chat/${sessionId}`) router.push('/chat');
      try {
        await fetch(`/api/sessions?sessionId=${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
        // 削除完了後にサーバーと同期
        await mutateSessions();
      } catch {
        await mutateSessions();
      }
    },
    [router, pathname, mutateSessions],
  );

  // 新規チャットでメッセージ送信時にサイドバーを楽観的更新 + URL遷移
  const handleSessionStart = useCallback(
    (sessionId: string, title: string) => {
      void mutateSessions(
        (prev) => [{ id: sessionId, sessionId, title, updatedAt: new Date().toISOString() }, ...(prev || [])],
        { revalidate: false },
      );
      // URL のみ更新（React ルーティングを介さない — コンポーネントのリマウントを防止）
      window.history.replaceState(null, '', `/chat/${sessionId}`);
    },
    [mutateSessions],
  );

  // SSEストリームからタイトル更新を受信した時にSWRキャッシュを更新
  const handleTitleUpdate = useCallback(
    (sessionId: string, title: string) => {
      void mutateSessions((prev) => prev?.map((s) => (s.sessionId === sessionId ? { ...s, title } : s)), {
        revalidate: false,
      });
    },
    [mutateSessions],
  );

  // 新しいチャット → key でリマウント（/chat にいる場合も /chat/[id] からの遷移も）
  const [chatKey, setChatKey] = useState(0);
  const handleNewChat = useCallback(() => {
    setChatKey((k) => k + 1);
    if (pathname !== '/chat') {
      router.push('/chat');
    }
  }, [pathname, router]);

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        email={email}
        sessions={sessions}
        projectId={projectId}
        projects={projects}
        onProjectSelect={setProjectId}
        onDeleteSession={handleDeleteSession}
        onNewChat={handleNewChat}
      />
      <ProjectProvider
        value={{ projectId, setProjectId, onSessionStart: handleSessionStart, onTitleUpdate: handleTitleUpdate }}
      >
        <main key={chatKey} className="flex-1 flex flex-col overflow-hidden">
          {children}
        </main>
      </ProjectProvider>
    </div>
  );
}
