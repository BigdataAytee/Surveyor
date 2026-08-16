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

import { chooseScale, looksLikeSurveyData, sheetDimensions } from '@surveyor/engine';

import { Button, Card } from '../ui/primitives.js';
import { SlideUp } from '../ui/motion.js';
import { EMPTY_MODEL, useProject } from '../state/store.js';
import type { Suggestion } from '../state/store.js';
import { deleteProject, newProjectId, saveProject } from '../state/library.js';
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
import { titleScaleIntent, titleScaleOffer } from './assistant.js';
import { createPlanner } from './planner.js';
import { annotationAnchor, makeTitleBlock, withParts } from '../state/annotations.js';
import { ExtractionCard } from './ExtractionCard.js';
import { extractEndpoint, prepareNote, transcribeNote } from './vision.js';
import { dismissNote, noteText, queueNote, transcribedNotes } from './queued-notes.js';
import { subscribeOutbox } from '../state/outbox.js';
import { useOnline } from '../state/useConnectivity.js';
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

  const online = useOnline();

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
   * The title and scale offer, once.
   *
   * Fired the first time a boundary validates, because that is the first
   * moment there is a scale to state — before it there is no extent to derive
   * one from. Once per session and never again: a card that reappears every
   * time the plan revalidates is a card people learn to dismiss without
   * reading, and this one is asking permission to write on their drawing.
   */
  const offered = useRef(false);
  useEffect(() => {
    if (offered.current) return;
    if (!pipeline.ok) return;
    if (pipeline.validation.status === 'error') return;
    if (pipeline.rings.length === 0) return;
    // Nothing to offer if the plan already carries one.
    if (state.model.titleBlock) return;

    offered.current = true;

    const { min, max } = pipeline.drawing.bounds;
    push(
      titleScaleOffer(
        { model: state.model, pipeline, suggestions: state.suggestions },
        chooseScale(
          { width: max.easting - min.easting, height: max.northing - min.northing },
          sheetDimensions('A4', 'portrait'),
        ),
      ),
    );
    // Deliberately keyed on the pipeline alone: the guard above is what makes
    // it once, and adding the model here would re-run it on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline]);

  /**
   * Transcriptions that finished while nobody was looking.
   *
   * A note photographed with no signal is read whenever signal returns, which
   * may be in a van an hour later with this sheet closed. The result waits in
   * the queue until it has been turned into an offer *and* that offer has been
   * used — so closing the sheet without confirming brings it back next time
   * rather than losing it.
   */
  const delivered = useRef<Set<string>>(new Set());
  useEffect(() => {
    function deliver(): void {
      for (const item of transcribedNotes()) {
        if (delivered.current.has(item.id)) continue;
        const text = noteText(item);
        if (text === null) continue;

        delivered.current.add(item.id);
        const note = item.payload as { data: string; mediaType: string };
        push({
          id: `msg_${item.id}`,
          role: 'assistant',
          text: `I read the photo you took offline (${item.label}). Check the numbers against it before you use them.`,
          offer: {
            id: `offer_${item.id}`,
            text,
            // The photograph goes back on screen beside the numbers. It is the
            // one part of a transcription anybody can actually check.
            imageUrl: `data:${note.mediaType};base64,${note.data}`,
          },
          queuedNoteId: item.id,
        });
      }
    }

    deliver();
    return subscribeOutbox(deliver);
    // Once. `push` is stable and the subscription does the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Open a blank sheet as a *separate* project.
   *
   * This used to empty the open project instead — `set-model` with an empty
   * model — which meant the autosave promptly wrote the blank plan over the
   * user's survey. There was no new project and no old one either: the work
   * was simply gone, and the library that exists to prevent exactly that never
   * saw it happen. The Project panel had always done this correctly; the
   * assistant's path had not been brought across.
   */
  function startFreshProject(): void {
    dispatch({ type: 'open-project', id: newProjectId(), model: EMPTY_MODEL });
  }

  /**
   * Answer a request to start a new project.
   *
   * The reply *is* the question, rather than a button that asks it. Someone who
   * has just typed "start a new project" has already made that decision; making
   * them press a button labelled with what they just said, only to be asked
   * something else, is a step that exists for the app's benefit and not theirs.
   *
   * What is genuinely undecided is the plan being left behind, so that is what
   * gets asked.
   */
  function beginNewProject(): void {
    // An empty plan has nothing to lose, so asking would be a question with no
    // stakes and only one sensible answer.
    const points = state.model.points.length;
    const features = state.model.siteFeatures.length;

    if (points === 0 && features === 0) {
      startFreshProject();
      push({
        id: `msg_${Date.now()}`,
        role: 'assistant',
        text: 'Done \u2014 a blank sheet. Paste your points in, photograph a note, or tell me how you\u2019d like to start.',
      });
      return;
    }

    // Both answers open a blank sheet; they differ only in whether the plan
    // being left behind is still there afterwards.
    push({
      id: `msg_${Date.now()}`,
      role: 'assistant',
      text:
        `Before I open a blank sheet \u2014 do you want to keep \u201c${projectName(state.model)}\u201d? ` +
        `It has ${points} point${points === 1 ? '' : 's'}` +
        `${features > 0 ? ` and ${features} feature${features === 1 ? '' : 's'}` : ''} on it.\n\n` +
        'Keeping it puts it in Projects, where you can reopen it any time. ' +
        'Discarding deletes it, and that one I cannot undo.',
      actions: [
        {
          id: `act_${Date.now()}_s`,
          label: 'Save it, then start fresh',
          intent: { kind: 'confirm-new-project', save: true },
          tone: 'primary',
        },
        {
          id: `act_${Date.now()}_d`,
          label: 'Discard it and start fresh',
          intent: { kind: 'confirm-new-project', save: false },
        },
        { id: `act_${Date.now()}_k`, label: 'Keep working on this', intent: { kind: 'none' } },
      ],
    });
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

    /*
     * A typed request for the title or the scale goes to the same handler the
     * card's buttons do, before the planner sees it. The architecture asks for
     * exactly this: the button and the command must call one code path, and the
     * way to guarantee that is for the words to become the same `Intent`.
     */
    const titled = titleScaleIntent(trimmed);
    if (titled) {
      runAction({ id: `act_${Date.now()}`, label: trimmed, intent: titled });
      return;
    }

    // A thinking indicator only for typed questions — B.4 is explicit that it
    // should not appear for every tiny response. With a model planner the wait
    // is real; with rules it is a beat so the reply does not appear mid-keypress.
    setThinking(true);
    // The conversation so far, so a follow-up like "what about the garage?"
    // or a bare "yes" after a clarifying question can be understood at all.
    const history = messages.map((message) => ({
      role: message.role,
      text: message.text,
    }));
    void planner.reply(trimmed, ctx, [...history, { role: 'user' as const, text: trimmed }]).then(
      (message) => {
        setThinking(false);

        // A request to start a new project is answered by the question it
        // raises, not by a button that repeats the request back. The planner
        // resolves the intent; what follows from it is decided here, because
        // only this component knows what is currently on the drawing.
        if (message.actions?.some((action) => action.intent.kind === 'new-project')) {
          beginNewProject();
          return;
        }

        push(message);
      },
    );
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

  /**
   * A photographed note.
   *
   * Reading handwriting needs a model, and a model needs a network — this is
   * the one thing in the app that genuinely cannot happen on site. So when
   * there is no signal the photograph is kept rather than refused, and read
   * when there is. Refusing it would mean the surveyor either writes the page
   * out by hand or photographs it again later, and the second one is not an
   * option once they have driven away from the site.
   */
  async function handlePhoto(file: File): Promise<void> {
    const imageUrl = URL.createObjectURL(file);
    push({ id: `msg_${Date.now()}`, role: 'user', text: `📷 ${file.name}` });

    if (!extractEndpoint()) {
      push({
        id: `msg_${Date.now()}`,
        role: 'assistant',
        text:
          'Reading photos needs the extraction service, which is not set up on ' +
          'this deployment. You can still paste or type the numbers and I will read those.',
      });
      URL.revokeObjectURL(imageUrl);
      return;
    }

    setThinking(true);
    const prepared = await prepareNote(file);

    if (!prepared) {
      setThinking(false);
      push({ id: `msg_${Date.now()}`, role: 'assistant', text: 'I could not open that image.' });
      URL.revokeObjectURL(imageUrl);
      return;
    }

    if (!online) {
      setThinking(false);
      await queueNote(prepared, file.name);
      push({
        id: `msg_${Date.now()}`,
        role: 'assistant',
        text:
          'You are offline, so I have kept the photo. I will read it as soon as ' +
          'there is signal and show you what I find — you do not need to keep ' +
          'this open.',
      });
      URL.revokeObjectURL(imageUrl);
      return;
    }

    const result = await transcribeNote(prepared);
    setThinking(false);

    if (!result.ok) {
      // Unreachable is worth keeping the photo for; a service that read it and
      // found no coordinates is not, and queueing that would retry a photo
      // that will be refused identically every time.
      if (result.unreachable) {
        await queueNote(prepared, file.name);
        push({
          id: `msg_${Date.now()}`,
          role: 'assistant',
          text: `${result.reason} I have kept the photo and will read it when the service is back.`,
        });
      } else {
        push({ id: `msg_${Date.now()}`, role: 'assistant', text: result.reason });
      }
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
      case 'new-project':
        beginNewProject();
        return;
      case 'confirm-new-project': {
        const name = projectName(state.model);

        if (intent.save) {
          // Written now rather than left to the autosave debounce: the next
          // thing that happens is this project being closed, and a save that
          // was still pending when that happened would lose the last edits —
          // which is the exact opposite of what pressing "save it" asked for.
          saveProject(state.projectId, state.model);
        } else {
          deleteProject(state.projectId);
        }

        startFreshProject();
        push({
          id: `msg_${Date.now()}`,
          role: 'assistant',
          text: intent.save
            ? `Saved “${name}” — you’ll find it under Projects. Here’s a blank sheet: paste your points in, photograph a note, or start drawing the boundary.`
            : `Discarded “${name}”. Here’s a blank sheet: paste your points in, photograph a note, or start drawing the boundary.`,
        });
        return;
      }
      /*
       * The title, the fraction and the bar.
       *
       * The single place either route ends up: this handler is what the card's
       * buttons reach and what a typed "add the title and scale" reaches, so
       * the two cannot drift. It creates a block when there is none and turns
       * parts on when there is — and it never overwrites a field the surveyor
       * has typed, because `withParts` only ever sets the `show` flags.
       */
      case 'add-title-block': {
        const parts = {
          ...(intent.title ? { title: true } : {}),
          ...(intent.representativeFraction ? { representativeFraction: true } : {}),
          ...(intent.scaleBar ? { scaleBar: true } : {}),
        };

        const existing = state.model.titleBlock;
        if (existing) {
          dispatch({ type: 'update-title-block', patch: withParts(existing, parts) });
        } else {
          dispatch({
            type: 'add-title-block',
            block: makeTitleBlock(
              annotationAnchor(state.model, pipeline.ok ? pipeline.drawing.bounds : null),
              // A block created for one part shows only that part; the others
              // are added by pressing their own button.
              {
                title: parts.title ?? false,
                representativeFraction: parts.representativeFraction ?? false,
                scaleBar: parts.scaleBar ?? false,
              },
            ),
          });
        }

        push({
          id: `msg_${Date.now()}`,
          role: 'assistant',
          text:
            'Done — it is on the drawing, below the plan. Tap it to edit the ' +
            'wording or pick a fixed scale; anything you type there stays as ' +
            'you left it.',
        });
        return;
      }

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
            <Message message={message} onAction={runAction} onAskAgain={send} online={online} />
            {message.offer ? (
              <ExtractionCard
                offer={message.offer}
                onApplied={(count) => {
                  // The queued photograph has now done its job, so it leaves
                  // the queue. Not a moment sooner.
                  if (message.queuedNoteId) void dismissNote(message.queuedNoteId);
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
                  });
                }}
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
/**
 * What to call the open plan when talking about it.
 *
 * The same fallback the library uses, so the assistant names a project the way
 * the Projects list will — being told you saved "25 High Street" and then
 * finding "Untitled plan" is a small betrayal of an otherwise fine feature.
 */
function projectName(model: { metadata: { siteAddress?: string } }): string {
  const address = model.metadata.siteAddress?.trim();
  return address && address.length > 0 ? address : 'Untitled plan';
}

function summarisePaste(text: string): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const head = lines.slice(0, 2).join('\n');
  return lines.length > 2 ? `${head}\n… ${lines.length - 2} more lines` : head;
}

function Message({
  message,
  onAction,
  onAskAgain,
  online,
}: {
  readonly message: AssistantMessage;
  readonly onAction: (action: AssistantAction) => void;
  readonly onAskAgain: (question: string) => void;
  readonly online: boolean;
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

      {/*
        Said on the answer rather than as a banner, because it is a fact about
        *this* reply: the offline planner is a real assistant, not an error
        state, and the next question may well reach the model. The offer to ask
        again appears only once there is signal — a button that cannot work yet
        is worse than no button.
      */}
      {message.answeredOffline ? (
        <div className="ai__offline">
          <span className="ai__offline-note">Answered offline, without the model.</span>
          {online && message.question ? (
            <Button size="sm" onClick={() => onAskAgain(message.question ?? '')}>
              Ask again, now you’re online
            </Button>
          ) : null}
        </div>
      ) : null}

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
