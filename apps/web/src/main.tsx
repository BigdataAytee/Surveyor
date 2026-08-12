import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './design/tokens.css';
import { AuthGate } from './auth/AuthGate.js';
import { ProjectProvider } from './state/store.js';
import { Workspace } from './screens/Workspace.js';

const host = document.getElementById('root');
if (!host) throw new Error('Missing #root');

createRoot(host).render(
  <StrictMode>
    {/*
      Outside the project provider on purpose: nothing should read or write a
      survey before the app knows whose session it is.
    */}
    <AuthGate>
      <ProjectProvider>
        <Workspace />
      </ProjectProvider>
    </AuthGate>
  </StrictMode>,
);
