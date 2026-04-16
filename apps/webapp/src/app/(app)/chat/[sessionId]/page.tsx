'use client';

import { use } from 'react';
import { ChatInterface } from '@/app/(root)/components/ChatInterface';
import { useProject } from '@/lib/project-context';

export default function SessionPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = use(params);
  const { projectId } = useProject();
  return <ChatInterface projectId={projectId} sessionId={sessionId} />;
}
