'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Terminal,
  FolderOpen,
  ShieldAlert,
  Plus,
  Trash2,
  Menu,
  X,
  Check,
  ChevronDown,
  LogOut,
  Database,
  User,
} from 'lucide-react';
import type { ProjectInfo } from '@/app/api/projects/route';

export interface SessionItem {
  id: string;
  sessionId: string;
  title: string;
  updatedAt: string;
}

const NAV_ITEMS = [
  { href: '/query', icon: Terminal, label: 'SQLクエリ' },
  { href: '/storage', icon: FolderOpen, label: 'ストレージ' },
  { href: '/audit', icon: ShieldAlert, label: '監査ログ' },
];

function ProjectSelector({
  projects,
  projectId,
  onSelect,
}: {
  projects: ProjectInfo[] | null;
  projectId: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = projects?.find((p) => p.projectId === projectId);

  if (projects === null) return <Skeleton className="h-8 w-full rounded-md" />;
  if (projects.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={`flex w-full items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
            selected ? 'hover:bg-accent' : 'border-primary text-primary animate-pulse'
          }`}
        >
          <FolderOpen className="size-3.5 shrink-0" />
          <span className="truncate flex-1 text-left">{selected?.projectName ?? 'プロジェクトを選択'}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto min-w-48 p-1">
        {projects.map((p) => (
          <button
            key={p.projectId}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent transition-colors"
            onClick={() => {
              onSelect(p.projectId);
              setOpen(false);
            }}
          >
            <Check className={`size-3.5 ${p.projectId === projectId ? 'opacity-100' : 'opacity-0'}`} />
            {p.projectName}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function Sidebar({
  email,
  sessions,
  projectId,
  projects,
  onProjectSelect,
  onDeleteSession,
  onNewChat,
}: {
  email: string;
  sessions: SessionItem[];
  projectId: string;
  projects: ProjectInfo[] | null;
  onProjectSelect: (id: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onNewChat: () => void;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  const isActive = (href: string) => pathname.startsWith(href);
  const isSessionActive = (sessionId: string) => pathname === `/chat/${sessionId}`;

  return (
    <>
      {/* モバイルハンバーガー */}
      <button
        className="fixed top-3 left-3 z-50 md:hidden rounded-md p-2 hover:bg-accent"
        onClick={() => setMobileOpen(!mobileOpen)}
      >
        {mobileOpen ? <X className="size-5" /> : <Menu className="size-5" />}
      </button>

      {/* オーバーレイ */}
      {mobileOpen && <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={() => setMobileOpen(false)} />}

      {/* サイドバー本体 */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-64 bg-background border-r flex flex-col transition-transform md:translate-x-0 md:static ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* タイトル */}
        <div className="px-4 py-3 border-b">
          <button
            onClick={() => {
              onNewChat();
              setMobileOpen(false);
            }}
            className="flex items-center gap-2 text-foreground hover:opacity-80 transition-opacity"
          >
            <Database className="size-5 text-primary" />
            <span className="font-semibold tracking-tight">Agentic Analyst</span>
          </button>
        </div>

        {/* New Chat */}
        <div className="p-3">
          <Button
            className="w-full justify-start gap-2"
            onClick={() => {
              onNewChat();
              setMobileOpen(false);
            }}
          >
            <Plus className="size-4" />
            新しいチャット
          </Button>
        </div>

        {/* セッション一覧 */}
        {/* Radix ScrollArea の内部 div が display:table になりトランケーションが効かないため !block で上書き */}
        <ScrollArea className="min-h-0 flex-1 [&>[data-radix-scroll-area-viewport]>div]:!block">
          <div className="px-2 space-y-0.5">
            {sessions.map((s) => (
              <div
                key={s.sessionId}
                className={`group relative flex h-8 items-center rounded-md text-sm transition-colors ${
                  isSessionActive(s.sessionId) ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                }`}
              >
                <Link
                  href={`/chat/${s.sessionId}`}
                  className="flex-1 truncate px-3 py-1.5"
                  onClick={() => setMobileOpen(false)}
                >
                  {s.title}
                </Link>
                <div
                  className={`absolute right-0 flex h-full items-center bg-gradient-to-l to-transparent pl-6 pr-1 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto transition-opacity ${
                    isSessionActive(s.sessionId)
                      ? 'from-accent from-80%'
                      : 'from-background from-80% group-hover:from-accent/50'
                  }`}
                >
                  <button
                    aria-label={`${s.title}を削除`}
                    className="rounded p-1 text-destructive hover:bg-destructive/10"
                    onClick={(e) => {
                      e.preventDefault();
                      onDeleteSession(s.sessionId);
                    }}
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>

        {/* ツール */}
        <div className="border-t p-2 space-y-0.5">
          <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
            ツール
          </div>
          {NAV_ITEMS.map(({ href, icon: Icon, label }) => (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                isActive(href) ? 'bg-accent text-accent-foreground font-medium' : 'hover:bg-accent/50'
              }`}
              onClick={() => setMobileOpen(false)}
            >
              <Icon className="size-4" />
              {label}
            </Link>
          ))}
        </div>

        {/* プロジェクト選択 */}
        <div className="border-t p-3">
          <ProjectSelector projects={projects} projectId={projectId} onSelect={onProjectSelect} />
        </div>

        {/* ユーザー情報 */}
        <div className="border-t p-3 flex items-center gap-2">
          <User className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="text-xs text-muted-foreground truncate flex-1">{email}</span>
          {/* oxlint-disable-next-line nextjs/no-html-link-for-pages -- API Routeへのリダイレクトのため */}
          <a href="/api/auth/sign-out" className="p-1 rounded hover:bg-accent">
            <LogOut className="size-3.5 text-muted-foreground" />
          </a>
        </div>
      </aside>
    </>
  );
}
