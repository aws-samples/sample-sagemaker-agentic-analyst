'use client';

import { StorageBrowserInterface } from '@/app/(root)/components/StorageBrowserInterface';
import { useProject } from '@/lib/project-context';

export default function StoragePage() {
  const { projectId } = useProject();
  return (
    <div className="flex-1 overflow-auto">
      <StorageBrowserInterface projectId={projectId} />
    </div>
  );
}
