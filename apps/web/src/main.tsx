import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './design/tokens.css';
import { ProjectProvider } from './state/store.js';
import { Workspace } from './screens/Workspace.js';

const host = document.getElementById('root');
if (!host) throw new Error('Missing #root');

createRoot(host).render(
  <StrictMode>
    <ProjectProvider>
      <Workspace />
    </ProjectProvider>
  </StrictMode>,
);
