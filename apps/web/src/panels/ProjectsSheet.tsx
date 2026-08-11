/**
 * The project library.
 *
 * Every saved survey, with what it is, when it was last touched, how big it
 * is, and a thumbnail of its boundary. The thumbnail is drawn from the stored
 * geometry rather than a cached image, which means it can never show a plan
 * that is no longer there — a stale preview of a survey you have since
 * corrected is worse than no preview at all.
 *
 * Every destructive action asks, and the one that cannot be undone by ordinary
 * means — deleting a project — says what it is deleting.
 */

import { useMemo, useState } from 'react';

import type { SurveyDataModel } from '@surveyor/contracts';
import { boundsOf, computeRing } from '@surveyor/engine';

import { Button, Card, EmptyState, Field, Segmented, StatusBadge, TextInput } from '../ui/primitives.js';
import { useProject } from '../state/store.js';
import {
  STORAGE_NOTE,
  deleteProject,
  duplicateProject,
  listProjects,
  loadProject,
  newProjectId,
  renameProject,
  restoreVersion,
  versionsOf,
  type ProjectSummary,
} from '../state/library.js';
import { EMPTY_MODEL } from '../state/store.js';
import './panels.css';

type Sort = 'recent' | 'name' | 'size';

export function ProjectsSheet({ onClose }: { readonly onClose: () => void }) {
  const { state, dispatch } = useProject();
  // Bumped to re-read local storage after a change; the library is not React
  // state and nothing else would tell this component it had moved.
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('recent');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [historyOf, setHistoryOf] = useState<string | null>(null);

  const projects = useMemo(() => listProjects(), [revision]);
  const refresh = () => setRevision((n) => n + 1);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching = needle.length === 0
      ? projects
      : projects.filter((project) => project.name.toLowerCase().includes(needle));

    return [...matching].sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name);
      if (sort === 'size') return (b.area ?? 0) - (a.area ?? 0);
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }, [projects, query, sort]);

  function open(id: string): void {
    const model = loadProject(id);
    if (!model) return;
    dispatch({ type: 'open-project', id, model });
    onClose();
  }

  return (
    <div className="panel">
      <div className="panel__toolbar">
        <Segmented
          ariaLabel="Sort projects"
          value={sort}
          onChange={setSort}
          options={[
            { value: 'recent', label: 'Recent' },
            { value: 'name', label: 'Name' },
            { value: 'size', label: 'Size' },
          ]}
        />
        <span className="panel__count numeric">
          {projects.length} project{projects.length === 1 ? '' : 's'}
        </span>
      </div>

      {projects.length > 3 ? (
        <Field label="Find a project">
          <TextInput
            ariaLabel="Search projects"
            value={query}
            placeholder="Site name"
            onChange={setQuery}
          />
        </Field>
      ) : null}

      {shown.length === 0 ? (
        <EmptyState
          title={query.length > 0 ? 'Nothing matches that' : 'No saved projects yet'}
          description={
            query.length > 0
              ? 'Try part of the site name.'
              : 'Projects are saved as you work. Start one and it will appear here.'
          }
        />
      ) : (
        <ul className="projects">
          {shown.map((project) => (
            <li key={project.id}>
              <ProjectCard
                project={project}
                current={project.id === state.projectId}
                open={() => open(project.id)}
                confirming={confirming === project.id}
                onConfirmDelete={() => setConfirming(project.id)}
                onCancelDelete={() => setConfirming(null)}
                onDelete={() => {
                  deleteProject(project.id);
                  setConfirming(null);
                  // Deleting the open project leaves nothing sensible on the
                  // canvas, so it is replaced with an empty one rather than
                  // left showing a survey that no longer exists.
                  if (project.id === state.projectId) {
                    dispatch({ type: 'open-project', id: newProjectId(), model: EMPTY_MODEL });
                  }
                  refresh();
                }}
                onDuplicate={() => {
                  duplicateProject(project.id);
                  refresh();
                }}
                onRename={(name) => {
                  renameProject(project.id, name);
                  refresh();
                }}
                showHistory={historyOf === project.id}
                onToggleHistory={() =>
                  setHistoryOf((current) => (current === project.id ? null : project.id))
                }
                onRestore={(at) => {
                  const model = restoreVersion(project.id, at);
                  if (!model) return;
                  dispatch({ type: 'open-project', id: project.id, model });
                  refresh();
                  onClose();
                }}
              />
            </li>
          ))}
        </ul>
      )}

      <p className="panel__body">{STORAGE_NOTE}</p>

      <div className="panel__footer panel__footer--stacked">
        <Button
          full
          variant="primary"
          onClick={() => {
            dispatch({ type: 'open-project', id: newProjectId(), model: EMPTY_MODEL });
            onClose();
          }}
        >
          Start a new project
        </Button>
        <Button full onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A project
// ---------------------------------------------------------------------------

function ProjectCard({
  project,
  current,
  open,
  confirming,
  onConfirmDelete,
  onCancelDelete,
  onDelete,
  onDuplicate,
  onRename,
  showHistory,
  onToggleHistory,
  onRestore,
}: {
  readonly project: ProjectSummary;
  readonly current: boolean;
  readonly open: () => void;
  readonly confirming: boolean;
  readonly onConfirmDelete: () => void;
  readonly onCancelDelete: () => void;
  readonly onDelete: () => void;
  readonly onDuplicate: () => void;
  readonly onRename: (name: string) => void;
  readonly showHistory: boolean;
  readonly onToggleHistory: () => void;
  readonly onRestore: (at: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(project.name);
  const versions = useMemo(() => (showHistory ? versionsOf(project.id) : []), [showHistory, project.id]);

  return (
    <Card tone={current ? 'suggested' : 'sunken'} className="project">
      <div className="project__head">
        <Thumbnail model={loadProject(project.id)} />
        <div className="project__facts">
          {renaming ? (
            <div className="tools__row">
              <TextInput ariaLabel="Project name" value={draft} onChange={setDraft} />
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  onRename(draft);
                  setRenaming(false);
                }}
              >
                Save
              </Button>
            </div>
          ) : (
            <p className="project__name">{project.name}</p>
          )}

          <p className="project__meta numeric">
            {project.pointCount} point{project.pointCount === 1 ? '' : 's'}
            {project.featureCount > 0 ? ` · ${project.featureCount} features` : ''}
            {project.area !== null ? ` · ${Math.round(project.area)} m²` : ''}
          </p>
          <p className="project__meta">Edited {when(project.updatedAt)}</p>
          {current ? <StatusBadge tone="suggested">Open now</StatusBadge> : null}
        </div>
      </div>

      {confirming ? (
        <>
          <p className="panel__body">
            Delete “{project.name}” and its {project.versionCount} saved version
            {project.versionCount === 1 ? '' : 's'}? This cannot be undone.
          </p>
          <div className="tools__row">
            <Button full variant="danger" onClick={onDelete}>
              Delete it
            </Button>
            <Button full onClick={onCancelDelete}>
              Keep it
            </Button>
          </div>
        </>
      ) : (
        <div className="project__actions">
          {!current ? (
            <Button size="sm" variant="primary" onClick={open}>
              Open
            </Button>
          ) : null}
          <Button size="sm" onClick={() => setRenaming((r) => !r)}>
            Rename
          </Button>
          <Button size="sm" onClick={onDuplicate}>
            Duplicate
          </Button>
          {project.versionCount > 0 ? (
            <Button size="sm" onClick={onToggleHistory}>
              History ({project.versionCount})
            </Button>
          ) : null}
          <Button size="sm" variant="danger" onClick={onConfirmDelete}>
            Delete
          </Button>
        </div>
      )}

      {showHistory ? (
        <ul className="versions">
          {versions.length === 0 ? (
            <li className="project__meta">No earlier versions yet.</li>
          ) : (
            versions.map((version) => (
              <li key={version.at} className="versions__item">
                <span className="project__meta">
                  {when(version.at)} · {version.model.points.length} points
                </span>
                <Button size="sm" onClick={() => onRestore(version.at)}>
                  Restore
                </Button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </Card>
  );
}

/**
 * A boundary drawn small.
 *
 * Rendered from the stored geometry every time rather than cached as an image:
 * a thumbnail that lags behind the survey is a thumbnail that shows a plan the
 * user has already corrected, and they will trust it once and be wrong.
 */
function Thumbnail({ model }: { readonly model: SurveyDataModel | null }) {
  const path = useMemo(() => {
    if (!model) return null;
    const ring = model.boundary[0];
    if (!ring) return null;

    const computed = computeRing(ring, model.points);
    if (!computed.ok) return null;

    const vertices = computed.ring.vertices;
    if (vertices.length < 3) return null;

    const bounds = boundsOf(vertices);
    const width = bounds.max.easting - bounds.min.easting;
    const height = bounds.max.northing - bounds.min.northing;
    const span = Math.max(width, height, 1);

    return vertices
      .map((vertex, index) => {
        // Northing up, so the thumbnail is oriented like the drawing.
        const x = ((vertex.easting - bounds.min.easting) / span) * 44 + 2;
        const y = 46 - ((vertex.northing - bounds.min.northing) / span) * 44;
        return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ')
      .concat(' Z');
  }, [model]);

  return (
    <svg className="project__thumb" viewBox="0 0 48 48" aria-hidden="true">
      {path ? (
        <path d={path} className="project__thumb-shape" />
      ) : (
        <rect x="8" y="8" width="32" height="32" className="project__thumb-empty" />
      )}
    </svg>
  );
}

/** Dates as a surveyor reads them: how long ago, then the date. */
function when(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 'at some point';

  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  return new Date(then).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
