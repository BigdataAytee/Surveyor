/**
 * Connectivity, for React.
 *
 * Kept apart from `connectivity.ts` so that module stays plain TypeScript and
 * can be tested without a renderer — the rules about what "online" means are
 * worth testing, and a hook is not the place to keep them.
 */

import { useSyncExternalStore } from 'react';

import { connectivity, subscribeConnectivity, type Connectivity } from './connectivity.js';

export function useConnectivity(): Connectivity {
  return useSyncExternalStore(subscribeConnectivity, connectivity, () => 'online');
}

export function useOnline(): boolean {
  return useConnectivity() === 'online';
}
