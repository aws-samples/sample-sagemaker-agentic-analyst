// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';

import type { useProjectStore as UseProjectStoreType } from '@/stores/project-store';

// jsdom 環境では localStorage が利用可能。モジュールキャッシュを避けるため動的インポート
let useProjectStore: typeof UseProjectStoreType;

beforeEach(async () => {
  localStorage.clear();
  // モジュールキャッシュをクリアして persist ミドルウェアを再初期化
  const mod = await import('@/stores/project-store');
  useProjectStore = mod.useProjectStore;
  useProjectStore.setState({ projectId: '' });
});

describe('project-store', () => {
  it('setProjectId で projectId が更新される', () => {
    useProjectStore.getState().setProjectId('proj-123');
    expect(useProjectStore.getState().projectId).toBe('proj-123');
  });

  it('初期値は空文字', () => {
    expect(useProjectStore.getState().projectId).toBe('');
  });

  describe('persist（localStorage）', () => {
    it('setProjectId で localStorage に書き込まれる', async () => {
      // rehydrate で persist を有効化
      await useProjectStore.persist.rehydrate();

      useProjectStore.getState().setProjectId('proj-123');

      const stored = JSON.parse(localStorage.getItem('project-selection')!);
      expect(stored.state.projectId).toBe('proj-123');
    });

    it('localStorage から rehydrate で復元される', async () => {
      localStorage.setItem('project-selection', JSON.stringify({ state: { projectId: 'proj-saved' }, version: 0 }));

      await useProjectStore.persist.rehydrate();

      expect(useProjectStore.getState().projectId).toBe('proj-saved');
    });
  });
});

describe('無効プロジェクトIDの自動リセット', () => {
  // AppShell の useEffect と同じロジック
  const resetIfInvalid = (
    projects: { projectId: string }[] | null,
    projectId: string,
    setProjectId: (id: string) => void,
  ) => {
    if (projects && projectId && !projects.some((p) => p.projectId === projectId)) {
      setProjectId('');
    }
  };

  it('projectId がプロジェクト一覧に存在しない場合、空文字にリセットされる', () => {
    useProjectStore.getState().setProjectId('stale-id');
    const projects = [{ projectId: 'proj-a' }, { projectId: 'proj-b' }];

    resetIfInvalid(projects, useProjectStore.getState().projectId, useProjectStore.getState().setProjectId);

    expect(useProjectStore.getState().projectId).toBe('');
  });

  it('projectId がプロジェクト一覧に存在する場合、リセットされない', () => {
    useProjectStore.getState().setProjectId('proj-a');
    const projects = [{ projectId: 'proj-a' }, { projectId: 'proj-b' }];

    resetIfInvalid(projects, useProjectStore.getState().projectId, useProjectStore.getState().setProjectId);

    expect(useProjectStore.getState().projectId).toBe('proj-a');
  });

  it('projects が null（未取得）の場合、リセットされない', () => {
    useProjectStore.getState().setProjectId('proj-a');

    resetIfInvalid(null, useProjectStore.getState().projectId, useProjectStore.getState().setProjectId);

    expect(useProjectStore.getState().projectId).toBe('proj-a');
  });

  it('projectId が空文字の場合、リセットされない', () => {
    const projects = [{ projectId: 'proj-a' }];

    resetIfInvalid(projects, useProjectStore.getState().projectId, useProjectStore.getState().setProjectId);

    expect(useProjectStore.getState().projectId).toBe('');
  });
});
