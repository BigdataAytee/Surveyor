/**
 * Documents — the paperwork the survey came from.
 *
 * The app could already read a photographed field note and then had nowhere to
 * keep the photograph, so the evidence was thrown away the moment it had been
 * transcribed. When a boundary is questioned two years later, what settles it
 * is the deed, the title plan and the note the numbers were read off — not the
 * numbers, which are the thing in dispute.
 *
 * These are stored in the browser, which is a real limit rather than a
 * temporary one, so the limit is stated and enforced up front instead of
 * appearing as a failed save after someone has trusted it.
 */

import { useState } from 'react';

import { Button, Card, EmptyState, StatusBadge, TextInput } from '../ui/primitives.js';
import { useProject } from '../state/store.js';
import {
  MAX_DOCUMENT_BYTES,
  attachDocument,
  formatSize,
  listDocuments,
  readAsDataUrl,
  removeDocument,
  type StoredDocument,
} from '../state/documents.js';
import './panels.css';

export function DocumentsSheet({ onClose }: { readonly onClose: () => void }) {
  const { state } = useProject();
  const [documents, setDocuments] = useState<readonly StoredDocument[]>(() =>
    listDocuments(state.projectId),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);

  async function attach(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    setProblem(null);

    for (const file of [...files]) {
      let data: string;
      try {
        data = await readAsDataUrl(file);
      } catch (error) {
        setProblem(error instanceof Error ? error.message : `Could not read ${file.name}.`);
        return;
      }

      const result = attachDocument(state.projectId, file, data, note);
      if (!result.ok) {
        setProblem(result.reason);
        return;
      }
      setDocuments(result.documents);
    }
    setNote('');
  }

  const used = documents.reduce((total, document) => total + document.bytes, 0);

  return (
    <div className="panel">
      <div className="panel__toolbar">
        <span className="panel__count numeric">
          {documents.length} document{documents.length === 1 ? '' : 's'}
        </span>
        {documents.length > 0 ? (
          <StatusBadge tone="neutral">{formatSize(used)}</StatusBadge>
        ) : null}
      </div>

      {/* The note is typed before choosing the file, because afterwards the
          browser's file dialog has already closed over the answer. */}
      <TextInput
        ariaLabel="What is this document"
        value={note}
        placeholder="What is it? Deed, title plan, field note…"
        onChange={setNote}
      />

      <label className="importer__file">
        <input
          type="file"
          multiple
          accept="image/*,.pdf,.txt,.csv,.dxf"
          onChange={(event) => void attach(event.target.files)}
        />
        <span>Attach a document or photo</span>
      </label>

      {problem ? (
        <Card tone="sunken">
          <p className="panel__body">{problem}</p>
        </Card>
      ) : null}

      {documents.length === 0 ? (
        <EmptyState
          icon="❐"
          title="No documents yet"
          description={
            'Attach the deed, the title plan, the client brief or a photo of ' +
            'the field book, and they stay with this project.'
          }
        />
      ) : (
        <ul className="documents">
          {documents.map((document) => (
            <li key={document.id}>
              <Card tone="sunken" className="document">
                {document.type.startsWith('image/') ? (
                  <img className="document__thumb" src={document.data} alt="" />
                ) : (
                  <span className="document__thumb document__thumb--file" aria-hidden="true">
                    ❐
                  </span>
                )}

                <div className="document__facts">
                  <p className="document__name">{document.name}</p>
                  {document.note ? <p className="project__meta">{document.note}</p> : null}
                  <p className="project__meta numeric">
                    {formatSize(document.bytes)} · {document.addedAt.slice(0, 10)}
                  </p>
                </div>

                <div className="document__actions">
                  {/* Opened in a tab rather than previewed inline: a PDF or a
                      full-resolution photo deserves the browser's own viewer. */}
                  <Button
                    size="sm"
                    onClick={() => {
                      const tab = window.open();
                      if (tab) tab.document.write(viewerFor(document));
                    }}
                  >
                    Open
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setConfirming(document.id)}>
                    Remove
                  </Button>
                </div>

                {confirming === document.id ? (
                  <div className="tools__row">
                    <Button
                      full
                      variant="danger"
                      onClick={() => {
                        setDocuments(removeDocument(state.projectId, document.id));
                        setConfirming(null);
                      }}
                    >
                      Remove “{document.name}”
                    </Button>
                    <Button full onClick={() => setConfirming(null)}>
                      Keep it
                    </Button>
                  </div>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}

      <p className="panel__body">
        Up to {formatSize(MAX_DOCUMENT_BYTES)} per document, stored in this browser
        alongside the survey. They are not uploaded anywhere and do not follow you
        to another device.
      </p>

      <div className="panel__footer">
        <Button full variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}

/**
 * A minimal page that shows one stored document.
 *
 * The data URL is written into an element's `src`, never into the page as
 * markup, and the name is escaped — a document is a file somebody else
 * supplied, and its name is not trustworthy HTML.
 */
function viewerFor(document: StoredDocument): string {
  const title = escapeHtml(document.name);
  const body = document.type.startsWith('image/')
    ? `<img src="${document.data}" alt="${title}" style="max-width:100%;height:auto">`
    : `<embed src="${document.data}" type="${escapeHtml(document.type)}" style="width:100%;height:100vh">`;

  return `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="margin:0;background:#111">${body}</body>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
