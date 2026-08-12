/**
 * Whether anything is waiting.
 *
 * Deliberately absent when there is nothing to say. An app that shows a green
 * "online" badge at all times has spent a permanent piece of a phone screen on
 * the normal case, and trained everyone to ignore the one place that would
 * have told them something was wrong.
 *
 * So it appears in exactly two situations: the network is gone, or there is
 * work queued for when it comes back. Both are things a surveyor standing in a
 * field would want to know without asking.
 */

import { useEffect, useState } from 'react';

import { useConnectivity } from '../state/useConnectivity.js';
import {
  MAX_ATTEMPTS,
  outboxItems,
  subscribeOutbox,
  type OutboxItem,
} from '../state/outbox.js';
import './sync-status.css';

export function useOutbox(): readonly OutboxItem[] {
  const [items, setItems] = useState<readonly OutboxItem[]>(() => outboxItems());
  useEffect(() => subscribeOutbox(setItems), []);
  return items;
}

export function SyncStatus() {
  const state = useConnectivity();
  const items = useOutbox();

  const waiting = items.filter((item) => item.attempts < MAX_ATTEMPTS).length;
  const stuck = items.filter((item) => item.attempts >= MAX_ATTEMPTS).length;

  if (state === 'online' && waiting === 0 && stuck === 0) return null;

  const label =
    state === 'offline'
      ? waiting > 0
        ? `Offline — ${waiting} waiting`
        : 'Offline'
      : waiting > 0
        ? `Syncing ${waiting}`
        : `${stuck} not sent`;

  return (
    <span
      className={`sync sync--${state === 'offline' ? 'offline' : waiting > 0 ? 'busy' : 'stuck'}`}
      /*
       * Polite: this changes while someone is drawing, and a live region that
       * interrupts is worse than one that waits for a pause.
       */
      role="status"
      aria-live="polite"
      title={
        state === 'offline'
          ? 'No connection. Your work is saved on this device and anything waiting will be sent when you are back online.'
          : stuck > 0 && waiting === 0
            ? 'Some queued work could not be sent. Open the assistant to see it.'
            : 'Sending work that was queued while you were offline.'
      }
    >
      {label}
    </span>
  );
}
