import { FolderOpen } from 'lucide-react';

export function ProjectRequiredPlaceholder() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
        <FolderOpen className="w-6 h-6 text-primary" />
      </div>
      <h2 className="text-lg font-medium text-foreground mb-1">プロジェクトを選択してください</h2>
      <p className="text-sm text-muted-foreground max-w-sm">
        左下のプロジェクトセレクターからプロジェクトを選択すると、この画面を利用できます
      </p>
    </div>
  );
}
