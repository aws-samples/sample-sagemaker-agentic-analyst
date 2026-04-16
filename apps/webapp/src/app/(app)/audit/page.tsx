'use client';

import { CloudTrailQueryInterface } from '@/app/(root)/components/CloudTrailQueryInterface';

export default function AuditPage() {
  return (
    <div className="flex-1 overflow-hidden">
      <CloudTrailQueryInterface />
    </div>
  );
}
