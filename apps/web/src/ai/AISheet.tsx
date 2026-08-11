/**
 * AISheet (Architecture B.4, B.7).
 *
 * An expert sitting beside the drawing, not a generic chatbot: every reply is
 * grounded in the current Survey Data Model, and the action buttons operate on
 * it directly.
 *
 * The trust loop (B.7) lives here too — a proposal appears as a preview on the
 * canvas with Accept and Discard beside it, and only Accept turns it into
 * survey data.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { looksLikeSurveyData } from '@surveyor/engine';

import { Button, Card } from '../ui/primitives.js';
import { SlideUp } from '../ui/motion.js';
import { EMPTY_MODEL, useProject } from '../state/store.js';
import type { Suggestion } from '../state/store.js';
import {
  explainMessage,
  openingMessage,
  proposeBuilding,
  proposeNote,
  taskMessage,
  userMessage,
  type AssistantAction,
  type AssistantContext,
  type AssistantMessage,
  type PanelName,
} from './assistant.js';
import { createPlanner } from './planner.js';
import { ExtractionCard } from './ExtractionCard.js';
import { readNoteImage } from './vision.js';
import './ai.css';

export interface AISheetProps {
  readonly onOpenPanel: (panel: PanelName) => void;
  /** Lets the assistant put the user in a tool rather than describe where it is. */
  readonly onSelectTool: (tool: 'select' | 'draw' | 'measure') => void;
}

export function AISheet({ onOpenPanel, onSelectTool }: AISheetProps) {
  const { state, dispatch, pipeline } = useProject();
  const ctx: AssistantContext = {
    model: state.model,
    pipeline,
    suggestions: state.suggestions,
  };

  const [messages, setMessages] = useState<readonly AssistantMessage[]>(() => [
    openingMessage(ctx),
  ]);
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  /**
   * A model-backed planner only when an endpoint is configured; otherwise the
   * rule planner. The app is never given a key — only a URL — so there is no
   * build in which a credential reaches the browser.
   */
  const planner = useMemo(
    () =>
      createPlanner(import.meta.env.VITE_ASSISTANT_ENDPOINT, (reason) =>
        console.warn('[assistant] falling back to rules:', reason),
      ),
    [],
  );

  // The latest assistant message drives which objects pulse on the canvas.
  const latest = messages[messages.length - 1];
  useEffect(() => {
    dispatch({ type: 'highlight', id: latest?.references?.[0] ?? null });
  }, [latest, dispatch]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, thinking]);

  function push(message: AssistantMessage): void {
    setMessages((current) => [...current, message]);
  }

  /**
   * Data dropped into the conversation, from a paste or from a photograph.
   *
   * The reply is written here rather than by a planner because there is
   * nothing to decide: the extractor has already read the text, and what the
   * user needs is what it found and a way to confirm it.
   */
  function offerExtraction(text: string, imageUrl?: string): void {
    const offer = {
      id: `offer_${Date.now()}`,
      text,
      ...(imageUrl === undefined ? {} : { imageUrl }),
    };

    push({
      id: `msg_${Date.now()}`,
      role: 'assistant',
      text: imageUrl
        ? 'I read the note. Check the numbers against the photo before you use them.'
        : 'That looks like survey data rather than a question, so I read it through the importer. Here is what I got.',
      offer,
    });
  }

  function send(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;

    push(userMessage(trimmed));
    setDraft('');

    // A table typed or dropped into the box is data, not a question. Sending it
    // to a planner would get an answer about it at best; the extractor can
    // actually use it.
    if (looksLikeSurveyData(trimmed)) {
      offerExtraction(trimmed);
      return;
    }

    // A thinking indicator only for typed questions — B.4 is explicit that it
    // should not appear for every tiny response. With a model planner the wait
    // is real; with rules it is a beat so the reply does not appear mid-keypress.
    setThinking(true);
    void planner.reply(trimmed, ctx).then((message) => {
      setThinking(false);
      push(message);
    });
  }

  /**
   * Paste is intercepted rather than left to the input.
   *
   * A single-line input collapses the newlines out of a pasted table, and the
   * row structure is most of what the extractor reads — by the time the text
   * reached `send` it would be one long line. Taking it from the clipboard
   * event keeps it intact.
   */
  function handlePaste(event: React.ClipboardEvent<HTMLInputElement>): void {
    const pasted = event.clipboardData.getData('text');
    if (!looksLikeSurveyData(pasted)) return;

    event.preventDefault();
    push(userMessage(summarisePaste(pasted)));
    offerExtraction(pasted);
  }

  async function handlePhoto(file: File): Promise<void> {
    const imageUrl = URL.createObjectURL(file);
    push({ id: `msg_${Date.now()}`, role: 'user', text: `📷 ${file.name}` });
    setThinking(true);

    const result = await readNoteImage(file);
    setThinking(false);

    if (!result.ok) {
      push({ id: `msg_${Date.now()}`, role: 'assistant', text: result.reason });
      URL.revokeObjectURL(imageUrl);
      return;
    }
    offerExtraction(result.text, imageUrl);
  }

  function runAction(action: AssistantAction): void {
    const { intent } = action;

    switch (intent.kind) {
      case 'suggest-building': {
        const suggestion = proposeBuilding(ctx, intent.label);
        if (!suggestion) {
          push({
            id: `msg_${Date.now()}`,
            role: 'assistant',
            text:
              'I couldn’t find room inside the boundary for that without ' +
              'overlapping something. Try zooming in and placing it yourself.',
          });
          return;
        }
        dispatch({ type: 'suggest', suggestion });
        push({
          id: `msg_${Date.now()}`,
          role: 'assistant',
          text: `I’ve put a ${intent.label.toLowerCase()} on the drawing as a suggestion. Take a look, then accept or discard it.`,
          references: [suggestion.id],
        });
        return;
      }
      case 'suggest-note': {
        const suggestion = proposeNote();
        dispatch({ type: 'suggest', suggestion });
        push({
          id: `msg_${Date.now()}`,
          role: 'assistant',
          text: 'Here’s a note for the plan. Accept it to add it to the sheet.',
        });
        return;
      }
      case 'open':
        onOpenPanel(intent.panel);
        return;
      case 'explain':
        push(explainMessage(intent.topic));
        return;
      case 'guide':
        push(taskMessage(intent.task));
        return;
      case 'tool':
        // Doing it beats describing it: the assistant can put the user in the
        // right tool rather than telling them where the toolbar is.
        onSelectTool(intent.tool);
        push({
          id: `msg_${Date.now()}`,
          role: 'assistant',
          text:
            intent.tool === 'draw'
              ? 'You’re in the drawing tool now — tap each corner of the boundary.'
              : intent.tool === 'measure'
                ? 'Measure is on. Tap two points and I’ll give you the bearing and distance between them.'
                : 'Back to selecting.',
        });
        return;
      case 'new-project': {
        // Destructive, so it asks rather than acts. Undo reaches back past it
        // either way, and saying so is what makes confirming reasonable.
        const hasWork = state.model.points.length > 0 || state.model.siteFeatures.length > 0;
        if (!hasWork) {
          dispatch({ type: 'set-model', model: EMPTY_MODEL });
          push({
            id: `msg_${Date.now()}`,
            role: 'assistant',
            text: 'Done — this is a fresh project. Paste your points in, or tell me how you’d like to start.',
          });
          return;
        }
        push({
          id: `msg_${Date.now()}`,
          role: 'assistant',
          text: `This project has ${state.model.points.length} points and ${state.model.siteFeatures.length} features on it. Starting a new one replaces them — Undo brings them back if you change your mind.`,
          actions: [
            {
              id: `act_${Date.now()}`,
              label: 'Start a new project',
              intent: { kind: 'confirm-new-project' },
              tone: 'primary',
            },
            { id: `act_${Date.now()}_k`, label: 'Keep this one', intent: { kind: 'none' } },
          ],
        });
        return;
      }
      case 'confirm-new-project':
        dispatch({ type: 'set-model', model: EMPTY_MODEL });
        push({
          id: `msg_${Date.now()}`,
          role: 'assistant',
          text: 'Started a new project. Paste your points in, photograph a note, or ask me how to do anything in here.',
        });
        return;
      case 'show':
        dispatch({ type: 'highlight', id: intent.elementId });
        return;
      case 'none':
        send(action.label);
    }
  }

  return (
    <div className="ai">
      <div className="ai__messages" ref={listRef}>
        {messages.map((message, index) => (
          <SlideUp key={message.id} delay={index === messages.length - 1 ? 0 : 0}>
            <Message message={message} onAction={runAction} />
            {message.offer ? (
              <ExtractionCard
                offer={message.offer}
                onApplied={(count) =>
                  push({
                    id: `msg_${Date.now()}`,
                    role: 'assistant',
                    text:
                      `Done — ${count} points are on the drawing and the plan has been ` +
                      'laid out. Check the boundary order, then look at Review before ' +
                      'you export.' +
                      // Buildings and roads were not part of the paste, so they are
                      // still where they were. Said plainly rather than deleted:
                      // they may be this site's, and they may not.
                      (state.model.siteFeatures.length > 0
                        ? ` I left the ${state.model.siteFeatures.length} feature${
                            state.model.siteFeatures.length === 1 ? '' : 's'
                          } already on the drawing alone — delete them from Layers if they belong to a different site.`
                        : ''),
                  })
                }
              />
            ) : null}
          </SlideUp>
        ))}

        {thinking ? (
          <div className="ai__typing" aria-label="Assistant is thinking">
            <span />
            <span />
            <span />
          </div>
        ) : null}

        {state.suggestions.map((suggestion) => (
          <SlideUp key={suggestion.id}>
            <SuggestionCard suggestion={suggestion} />
          </SlideUp>
        ))}
      </div>

      <form
        className="ai__composer"
        onSubmit={(event) => {
          event.preventDefault();
          send(draft);
        }}
      >
        <label className="ai__camera">
          {/*
            `capture` opens the camera directly on a phone and is ignored on a
            desktop, where the same control becomes a file picker.
          */}
          <input
            type="file"
            accept="image/*"
            capture="environment"
            aria-label="Photograph a note"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void handlePhoto(file);
            }}
          />
          <span aria-hidden="true">📷</span>
        </label>
        <input
          className="ai__input"
          value={draft}
          placeholder="Ask, or paste your points…"
          aria-label="Ask the assistant, or paste survey data"
          onChange={(event) => setDraft(event.target.value)}
          onPaste={handlePaste}
        />
        <Button type="submit" variant="primary" size="sm" disabled={draft.trim().length === 0}>
          Send
        </Button>
      </form>
    </div>
  );
}

/** What to show in the conversation for a paste, rather than the whole table. */
function summarisePaste(text: string): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const head = lines.slice(0, 2).join('\n');
  return lines.length > 2 ? `${head}\n… ${lines.length - 2} more lines` : head;
}

function Message({
  message,
  onAction,
}: {
  readonly message: AssistantMessage;
  readonly onAction: (action: AssistantAction) => void;
}) {
  if (message.role === 'user') {
    return (
      <div className="ai__message ai__message--user">
        <p>{message.text}</p>
      </div>
    );
  }

  return (
    <div className="ai__message ai__message--assistant">
      <p>{message.text}</p>
      {message.actions && message.actions.length > 0 ? (
        <div className="ai__actions">
          {message.actions.map((action) => (
            <Button
              key={action.id}
              size="sm"
              variant={action.tone === 'primary' ? 'primary' : 'secondary'}
              onClick={() => onAction(action)}
            >
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The trust loop card (B.7). Accept flips provenance to user-confirmed and the
 * object becomes ordinary geometry; Discard removes it with no trace.
 */
function SuggestionCard({ suggestion }: { readonly suggestion: Suggestion }) {
  const { dispatch } = useProject();

  return (
    <Card tone="suggested" className="suggestion">
      <div className="suggestion__head">
        <span className="suggestion__mark" aria-hidden="true">
          ✦
        </span>
        <div>
          <p className="suggestion__summary">{suggestion.summary}</p>
          <p className="suggestion__detail">
            {suggestion.kind === 'note'
              ? suggestion.note.text
              : 'Not part of the survey until you accept it.'}
          </p>
        </div>
      </div>
      <div className="suggestion__actions">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => dispatch({ type: 'dismiss-suggestion', id: suggestion.id })}
        >
          Discard
        </Button>
        <Button
          size="sm"
          variant="primary"
          onClick={() =>
            dispatch({
              type: 'accept-suggestion',
              id: suggestion.id,
              at: new Date().toISOString(),
            })
          }
        >
          Accept
        </Button>
      </div>
    </Card>
  );
}
