'use client';

import { QueryInterface } from '@/app/(root)/components/QueryInterface';
import { useProject } from '@/lib/project-context';

export default function QueryPage() {
  const { projectId } = useProject();
  return (
    <div className="flex-1 overflow-auto">
      <QueryInterface projectId={projectId} />
    </div>
  );
}
