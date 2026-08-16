/**
 * The console's entry point.
 *
 * Its own bundle, its own page, its own stylesheet. Nothing here imports the
 * app's shell, its state, or its design system — the two surfaces have
 * opposite jobs and sharing anything is how they slowly become one surface
 * that suits neither.
 *
 * No service worker is registered. The app caches itself so a surveyor with no
 * signal can still draw; a monitoring console cached on somebody's device is
 * a page that opens showing stale figures with no way to tell they are stale,
 * which is worse than one that will not open at all.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { Console } from './Console.js';

const root = document.getElementById('root');
if (!root) throw new Error('no #root');

createRoot(root).render(
  <StrictMode>
    <Console />
  </StrictMode>,
);
