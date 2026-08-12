import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './design/tokens.css';
import { AuthGate } from './auth/AuthGate.js';
import { ProjectProvider } from './state/store.js';
import { Workspace } from './screens/Workspace.js';
import { registerOfflineShell } from './offline/register.js';
import { startOutbox } from './state/outbox.js';
// Imported for the side effect of registering its handler. Without this the
// queue would hold photographs nothing knows how to read.
import './ai/queued-notes.js';

const host = document.getElementById('root');
if (!host) throw new Error('Missing #root');

// The app has to open with no signal, and work waiting on a network has to go
// through when there is one. Both are started before the first render: neither
// needs the UI, and both are wanted from the first second.
registerOfflineShell();
startOutbox();

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
