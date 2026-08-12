/**
 * Photographed notes waiting for signal.
 *
 * The one thing in this app that genuinely cannot be done on site: reading
 * handwriting off a photograph needs a model, and a model needs a network.
 * Everything else — the geometry, the closure, the drawing, the assistant's
 * rule planner — already works with the radio off.
 *
 * So the photograph is kept instead of refused. When there is signal it is
 * read, and the transcription is kept too, because the surveyor who took it
 * may be nowhere near their phone by then. Nothing enters the survey on its
 * own: a finished transcription becomes an offer to confirm, exactly like one
 * read a second after the shutter. Provenance does not get weaker because the
 * network was slow.
 */

import {
  enqueue,
  outboxItems,
  registerOutboxHandler,
  removeFromOutbox,
  updateOutboxItem,
  type OutboxItem,
} from '../state/outbox.js';
import { extractEndpoint, transcribeNote, type PreparedNote } from './vision.js';

export interface QueuedNotePayload extends PreparedNote {
  /** Filled in once the service has read it. */
  readonly text?: string;
  readonly readAt?: string;
}

/** Keep a photograph for later. */
export async function queueNote(note: PreparedNote, label: string): Promise<void> {
  const payload: QueuedNotePayload = note;
  await enqueue('transcribe', label, payload);
}

/** Notes that have been read and are waiting for someone to look at them. */
export function transcribedNotes(): readonly OutboxItem[] {
  return outboxItems().filter((item) => item.kind === 'transcribe' && noteText(item) !== null);
}

export function noteText(item: OutboxItem): string | null {
  const payload = item.payload as QueuedNotePayload | null;
  return typeof payload?.text === 'string' ? payload.text : null;
}

/** Called once a transcription has been turned into an offer to confirm. */
export function dismissNote(id: string): Promise<void> {
  return removeFromOutbox(id);
}

registerOutboxHandler('transcribe', async (item) => {
  const payload = item.payload as QueuedNotePayload;

  // Already read. It stays in the queue until a person has seen it, which is
  // why the queue is the right place for it rather than a list of pending
  // requests: the work is done, the delivery is not.
  if (typeof payload.text === 'string') return { status: 'waiting' };

  if (!extractEndpoint()) {
    return {
      status: 'failed',
      reason: 'This build cannot read photographs. Paste or type the numbers instead.',
    };
  }

  const reading = await transcribeNote(payload);

  if (reading.ok) {
    /*
     * Stored rather than handed to a callback. The tab that took the
     * photograph may be long closed by the time there is signal, and a
     * transcription that only exists in a promise is one that vanishes if
     * nobody happens to be watching when it arrives.
     */
    await updateOutboxItem(item.id, {
      payload: { ...payload, text: reading.text, readAt: new Date().toISOString() },
    });
    return { status: 'waiting' };
  }

  return reading.unreachable
    ? { status: 'retry', reason: reading.reason }
    : { status: 'failed', reason: reading.reason };
});
