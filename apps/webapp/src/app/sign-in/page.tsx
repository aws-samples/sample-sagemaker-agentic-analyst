import { Database } from 'lucide-react';

export default function SignInPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
            <Database className="w-6 h-6 text-primary" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Agentic Analyst</h1>
          <p className="text-sm text-muted-foreground mt-1">サインインして続行</p>
        </div>

        <div className="rounded-2xl border bg-card p-6 shadow-sm">
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- API Routeへのリダイレクトのため<Link>は不適 */}
          <a
            href="/api/auth/sign-in"
            className="flex w-full justify-center py-2.5 px-4 rounded-xl text-sm font-medium text-primary-foreground bg-primary hover:opacity-90 transition-opacity"
          >
            Cognitoでサインイン
          </a>
        </div>

        <p className="text-center text-xs text-muted-foreground mt-6">© {new Date().getFullYear()} Agentic Analyst</p>
      </div>
    </div>
  );
}
