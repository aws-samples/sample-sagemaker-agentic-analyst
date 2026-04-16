'use client';

import Link from 'next/link';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Database, LogOut, User } from 'lucide-react';

interface HeaderProps {
  email: string;
}

export default function Header({ email }: HeaderProps) {
  return (
    <header className="border-b">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between h-12 items-center">
          <Link href="/" className="flex items-center gap-2 text-foreground hover:opacity-80 transition-opacity">
            <Database className="w-5 h-5 text-primary" />
            <span className="font-semibold tracking-tight">Agentic Analyst</span>
          </Link>
          <div className="flex items-center justify-between min-w-0 shrink max-w-80">
            <span className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground min-w-0">
              <User className="size-3.5 shrink-0" />
              <span className="truncate">{email}</span>
            </span>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- API Routeへのリダイレクトのため<Link>は不適 */}
                  <a
                    href="/api/auth/sign-out"
                    className="inline-flex items-center justify-center w-8 h-8 shrink-0 text-muted-foreground hover:text-foreground rounded-md hover:bg-secondary transition-colors"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                  </a>
                </TooltipTrigger>
                <TooltipContent>サインアウト</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
      </div>
    </header>
  );
}
