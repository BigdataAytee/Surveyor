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

import { Button, Card } from '../ui/primitives.js';
import { SlideUp } from '../ui/motion.js';
import { useProject } from '../state/store.js';
import type { Suggestion } from '../state/store.js';
import {
  explainMessage,
  openingMessage,
  proposeBuilding,
  proposeNote,
  userMessage,
  type AssistantAction,
  type AssistantContext,
  type AssistantMessage,
} from './assistant.js';
import { createPlanner } from './planner.js';
import './ai.css';

export interface AISheetProps {
  readonly onOpenPanel: (panel: 'data' | 'validation' | 'export' | 'layers') => void;
}

export function AISheet({ onOpenPanel }: AISheetProps) {
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

  function send(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;

    push(userMessage(trimmed));
    setDraft('');

    // A thinking indicator only for typed questions — B.4 is explicit that it
    // should not appear for every tiny response. With a model planner the wait
    // is real; with rules it is a beat so the reply does not appear mid-keypress.
    setThinking(true);
    void planner.reply(trimmed, ctx).then((message) => {
      setThinking(false);
      push(message);
    });
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
        <input
          className="ai__input"
          value={draft}
          placeholder="Ask about the plan…"
          aria-label="Ask the assistant"
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit" variant="primary" size="sm" disabled={draft.trim().length === 0}>
          Send
        </Button>
      </form>
    </div>
  );
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
