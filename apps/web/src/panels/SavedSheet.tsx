/**
 * Saved — the projects worth keeping to hand.
 *
 * The library holds everything ever opened, which is the right thing for it to
 * do and the wrong thing to scroll through when three sites are live and forty
 * are finished. Starring is the surveyor's own answer to which is which, so it
 * is stored on the project summary and never on the survey.
 */

import { useMemo, useState } from 'react';

import { Button, Card, EmptyState, StatusBadge } from '../ui/primitives.js';
import { useProject } from '../state/store.js';
import { listProjects, loadProject, toggleStar } from '../state/library.js';
import './panels.css';

export function SavedSheet({
  onClose,
  onOpenLibrary,
}: {
  readonly onClose: () => void;
  readonly onOpenLibrary: () => void;
}) {
  const { state, dispatch } = useProject();
  // Bumped to re-read storage after a star changes; the library is not React
  // state and nothing else would tell this component it had moved.
  const [revision, setRevision] = useState(0);

  const projects = useMemo(() => listProjects(), [revision]);
  const starred = projects.filter((project) => project.starred);

  return (
    <div className="panel">
      {starred.length === 0 ? (
        <EmptyState
          icon="★"
          title="Nothing saved yet"
          description={
            'Star a project and it will be here, so the sites you are working ' +
            'on now are not mixed in with every one you have ever opened.'
          }
          actions={
            <Button variant="primary" onClick={onOpenLibrary}>
              Go to Projects
            </Button>
          }
        />
      ) : (
        <ul className="projects">
          {starred.map((project) => (
            <li key={project.id}>
              <Card tone={project.id === state.projectId ? 'suggested' : 'sunken'} className="project">
                <div className="project__head">
                  <div className="project__facts">
                    <p className="project__name">{project.name}</p>
                    <p className="project__meta numeric">
                      {project.pointCount} point{project.pointCount === 1 ? '' : 's'}
                      {project.featureCount > 0 ? ` · ${project.featureCount} features` : ''}
                      {project.area !== null ? ` · ${Math.round(project.area)} m²` : ''}
                    </p>
                    {project.id === state.projectId ? (
                      <StatusBadge tone="suggested">Open now</StatusBadge>
                    ) : null}
                  </div>
                </div>

                <div className="project__actions">
                  {project.id !== state.projectId ? (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => {
                        const model = loadProject(project.id);
                        if (!model) return;
                        dispatch({ type: 'open-project', id: project.id, model });
                        onClose();
                      }}
                    >
                      Open
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    onClick={() => {
                      toggleStar(project.id);
                      setRevision((n) => n + 1);
                    }}
                  >
                    Unstar
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <div className="panel__footer panel__footer--stacked">
        <Button full variant="primary" onClick={onClose}>
          Done
        </Button>
        <Button full onClick={onOpenLibrary}>
          All projects
        </Button>
      </div>
    </div>
  );
}
