import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface ProjectStore {
  projectId: string;
  setProjectId: (id: string) => void;
}

export const useProjectStore = create<ProjectStore>()(
  persist(
    (set) => ({
      projectId: '',
      setProjectId: (id: string) => set({ projectId: id }),
    }),
    { name: 'project-selection', skipHydration: true },
  ),
);
