'use client';

import { ChatInterface } from '@/app/(root)/components/ChatInterface';
import { useProject } from '@/lib/project-context';

export default function ChatPage() {
  const { projectId, onSessionStart, onTitleUpdate } = useProject();
  return <ChatInterface projectId={projectId} onSessionStart={onSessionStart} onTitleUpdate={onTitleUpdate} />;
}
