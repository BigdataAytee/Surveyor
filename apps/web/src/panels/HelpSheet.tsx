/**
 * Help — how to do the things this app does.
 *
 * The steps are not written here. They are the assistant's own task guides,
 * rendered as a list: the assistant already had to know how to talk someone
 * through starting a project or drawing a boundary, and a help page with its
 * own copy of that would be a second set of instructions to keep in step with
 * the app. One of the two would go stale, and it would be this one.
 *
 * What is written here is the part the guides do not cover — the shortcuts,
 * and the two ideas a newcomer to this app has to understand before the rest
 * of it makes sense.
 */

import { useState } from 'react';

import { Button, Card, Segmented, TextInput } from '../ui/primitives.js';
import { TASKS } from '../ai/assistant.js';
import './panels.css';

type Topic = 'tasks' | 'keys' | 'ideas';

const SHORTCUTS: readonly { readonly keys: string; readonly does: string }[] = [
  { keys: 'V', does: 'Select' },
  { keys: 'D', does: 'Draw boundary corners' },
  { keys: 'M', does: 'Measure between two points' },
  { keys: 'I', does: 'Place a dimension' },
  { keys: 'A', does: 'Add to the drawing' },
  { keys: 'E', does: 'Modify the selection' },
  { keys: 'F', does: 'Turn snapping on or off' },
  { keys: 'Drag', does: 'Move around the drawing' },
  { keys: 'Shift + drag', does: 'Draw a box to select several things' },
  { keys: 'Shift + click', does: 'Add one more thing to the selection' },
  { keys: 'Delete', does: 'Delete what is selected' },
  { keys: 'Esc', does: 'Close a panel, clear the selection' },
  { keys: 'Ctrl + Z', does: 'Undo' },
  { keys: 'Ctrl + Shift + Z', does: 'Redo' },
];

const IDEAS: readonly { readonly title: string; readonly body: string }[] = [
  {
    title: 'Where every number comes from',
    body:
      'Nothing on the plan is typed twice. A dimension, an area, a bearing — each is ' +
      'computed from the survey points whenever the drawing is made, so correcting a ' +
      'point corrects everything that mentions it. This is also why the assistant is ' +
      'never allowed to write a survey value: it can say what to label, not what the ' +
      'label reads.',
  },
  {
    title: 'Measured, calculated, or suggested',
    body:
      'Every point and feature carries where it came from. Measured is what you ' +
      'surveyed, calculated is what the engine derived from it, and ai-suggested is a ' +
      'proposal waiting for you. Anything still suggested is held back at export until ' +
      'you have confirmed it, because a plan is a statement you are signing.',
  },
  {
    title: 'Closure, and why it is on the front page',
    body:
      'A traverse that does not close has an error in it somewhere. The misclosure is ' +
      'how far out the last leg lands from the first corner, and the precision ratio is ' +
      'that error against the distance walked — 1:8000 means one part in eight thousand. ' +
      'A boundary drawn from coordinates closes by construction, so the figure matters ' +
      'most on a traverse typed from a deed.',
  },
  {
    title: 'This browser is the whole filing cabinet',
    body:
      'There is no account and no server. Projects, versions, documents and settings all ' +
      'live in this browser, on this device. That makes the app work with no signal on ' +
      'site, and it means clearing site data clears everything — so export anything that ' +
      'has to survive.',
  },
];

export function HelpSheet({ onClose }: { readonly onClose: () => void }) {
  const [topic, setTopic] = useState<Topic>('tasks');
  const [query, setQuery] = useState('');

  const needle = query.trim().toLowerCase();
  const tasks = TASKS.filter(
    (task) =>
      needle.length === 0 ||
      task.title.toLowerCase().includes(needle) ||
      task.terms.some((term) => term.includes(needle)),
  );

  return (
    <div className="panel">
      <Segmented
        ariaLabel="Help topic"
        value={topic}
        onChange={setTopic}
        options={[
          { value: 'tasks', label: 'How do I…' },
          { value: 'keys', label: 'Shortcuts' },
          { value: 'ideas', label: 'Concepts' },
        ]}
      />

      {topic === 'tasks' ? (
        <>
          <TextInput
            ariaLabel="Search help"
            value={query}
            placeholder="Search — boundary, export, area…"
            onChange={setQuery}
          />
          {tasks.length === 0 ? (
            <Card tone="sunken">
              <p className="panel__body">
                Nothing matches “{query}”. The assistant can answer in your own
                words — ask it there instead.
              </p>
            </Card>
          ) : (
            <ul className="help">
              {tasks.map((task) => (
                <li key={task.task}>
                  <details className="help__item">
                    <summary>{task.title}</summary>
                    <ol className="help__steps">
                      {task.steps.map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ol>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}

      {topic === 'keys' ? (
        <>
          <ul className="help__keys">
            {SHORTCUTS.map((shortcut) => (
              <li key={shortcut.keys}>
                <kbd>{shortcut.keys}</kbd>
                <span>{shortcut.does}</span>
              </li>
            ))}
          </ul>
          <p className="panel__body">
            Every one of these has a button too — nothing in this app is reachable
            only by keyboard.
          </p>
        </>
      ) : null}

      {topic === 'ideas' ? (
        <ul className="help">
          {IDEAS.map((idea) => (
            <li key={idea.title}>
              <details className="help__item">
                <summary>{idea.title}</summary>
                <p className="panel__body">{idea.body}</p>
              </details>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="panel__footer">
        <Button full variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}
