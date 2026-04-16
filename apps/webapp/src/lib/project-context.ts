'use client';

import { createContext, useContext } from 'react';

const ProjectContext = createContext<{
  projectId: string;
  setProjectId: (id: string) => void;
  onSessionStart?: (sessionId: string, title: string) => void;
  onTitleUpdate?: (sessionId: string, title: string) => void;
}>({
  projectId: '',
  setProjectId: () => {},
});

export const ProjectProvider = ProjectContext.Provider;
export const useProject = () => useContext(ProjectContext);
