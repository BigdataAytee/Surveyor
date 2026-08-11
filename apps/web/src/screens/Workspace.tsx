/**
 * The main workspace (Architecture B.1, B.3, B.14, B.15).
 *
 * Visual hierarchy is enforced by layout: the drawing occupies everything that
 * is not chrome, and every panel is a sheet over it rather than a column beside
 * it. On a wide screen the assistant becomes a side rail — but the plan still
 * gets the majority of the pixels.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { contextFor, placeLabels, UNIT_ABBREVIATION } from '@surveyor/engine';

import { DrawingCanvas, type CanvasTool } from '../canvas/DrawingCanvas.js';
import { ProjectSheet } from '../panels/ProjectSheet.js';
import { PropertiesSheet } from '../panels/PropertiesSheet.js';
import { Segmented } from '../ui/primitives.js';
import { AISheet } from '../ai/AISheet.js';
import { DataSheet } from '../panels/DataSheet.js';
import { ExportDialog } from '../panels/ExportDialog.js';
import { STATUS_LABEL, ValidationSheet } from '../panels/ValidationSheet.js';
import {
  BottomSheet,
  Button,
  EmptyState,
  ProgressStepper,
  StatusBadge,
  Toast,
  type Step,
  type StatusTone,
} from '../ui/primitives.js';
import { FadeIn } from '../ui/motion.js';
import { useProject } from '../state/store.js';
import './workspace.css';

type Panel = 'ai' | 'data' | 'validation' | 'export' | 'layers' | 'properties' | 'project' | null;

/** Cap height the canvas stylesheet draws labels at, and its paper equivalent. */
const CANVAS_TEXT_PX = 11;
const CANVAS_TEXT_MM = 2.5;

const WORKFLOW: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'boundary', label: 'Boundary' },
  { id: 'survey', label: 'Survey' },
  { id: 'buildings', label: 'Buildings' },
  { id: 'features', label: 'Features' },
  { id: 'labels', label: 'Labels' },
  { id: 'review', label: 'Review' },
  { id: 'export', label: 'Export' },
];

export function Workspace() {
  const { state, dispatch, pipeline, canUndo, canRedo } = useProject();
  const [panel, setPanel] = useState<Panel>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [showLabels, setShowLabels] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [tool, setTool] = useState<CanvasTool>('select');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Keyboard shortcuts on desktop; the mobile UI reaches the same actions
  // through the toolbar, so nothing is keyboard-only.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === 'z' && !event.shiftKey) {
        event.preventDefault();
        dispatch({ type: 'undo' });
      } else if ((event.key === 'z' && event.shiftKey) || event.key === 'y') {
        event.preventDefault();
        dispatch({ type: 'redo' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch]);

  const status = pipeline.ok ? pipeline.validation.status : 'error';

  /**
   * An empty project is not a broken one.
   *
   * The pipeline correctly declines to draw nothing, but rendering that as a
   * red "Error" the moment someone starts a new project tells them they have
   * done something wrong when they have done exactly the right thing.
   */
  const nothingYet = state.model.points.length === 0;
  const tone: StatusTone = nothingYet
    ? 'neutral'
    : status === 'ready'
      ? 'ready'
      : status === 'needs-review'
        ? 'review'
        : 'error';

  const previews = useMemo(
    () => state.suggestions.flatMap((s) => (s.kind === 'feature' ? [s.feature] : [])),
    [state.suggestions],
  );

  const openPanel = useCallback((next: Panel) => setPanel(next), []);

  const drawing = pipeline.ok ? pipeline.drawing : pipeline.drawing;
  const empty = state.model.points.length === 0;

  /**
   * Places the plan's labels for whatever text size the canvas is currently
   * showing. `CANVAS_TEXT_PX` is the on-screen cap height the stylesheet draws;
   * turning it into an equivalent plan scale lets the engine's collision pass
   * work in the same units the user is actually looking at.
   */
  const labelsForScale = useCallback(
    (worldPerPixel: number) => {
      if (!pipeline.ok) return [];
      const scaleDenominator =
        (1000 * CANVAS_TEXT_PX * worldPerPixel) / CANVAS_TEXT_MM;

      return placeLabels({
        // On the sheet a boundary dimension is `required` — losing one is a
        // validation failure. On screen it is not: the user can zoom in. So
        // canvas placement lets everything drop, which turns crowding into
        // ordinary decluttering (fewer labels zoomed out, all of them zoomed
        // in) instead of a pile-up on top of the lines. Priority still decides
        // who wins the space.
        specs: pipeline.specs.map((spec) => ({ ...spec, visibility: 'optional' as const })),
        ctx: contextFor(state.model, pipeline.rings),
        options: {
          scaleDenominator,
          textHeightMm: CANVAS_TEXT_MM,
          clearanceMm: 1.2,
          obstacles: pipeline.drawing.layers
            .flatMap((layer) => layer.elements)
            .flatMap((element) => (element.kind === 'symbol' ? [] : [element.points])),
          avoidAreas: pipeline.drawing.layers
            .flatMap((layer) => layer.elements)
            .flatMap((element) =>
              element.kind === 'polygon'
                ? [{ ownerId: element.id, vertices: element.points }]
                : [],
            ),
        },
      }).labels;
    },
    [pipeline, state.model],
  );

  const workflowSteps: readonly Step[] = useMemo(
    () => buildWorkflow(state.model.points.length, state.model.siteFeatures.length, status),
    [state.model.points.length, state.model.siteFeatures.length, status],
  );

  return (
    <div className="workspace">
      <header className="topbar">
        <div className="topbar__left">
          {/*
            The site name is the thing on screen that names the project, so it
            is the thing people reach for when they want to start another one.
            Making it the way in is cheaper than a menu nobody finds.
          */}
          <button
            type="button"
            className="topbar__title"
            aria-label="Project settings and new project"
            onClick={() => openPanel('project')}
          >
            <span>{state.model.metadata.siteAddress ?? 'Untitled plan'}</span>
            <span className="topbar__title-chevron" aria-hidden="true">
              ⌄
            </span>
          </button>
          <ProgressStepper steps={workflowSteps} compact />
        </div>

        <div className="topbar__right">
          <StatusBadge tone={tone} onClick={() => openPanel('validation')}>
            {nothingYet ? 'Nothing yet' : STATUS_LABEL[status]}
          </StatusBadge>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Undo"
            disabled={!canUndo}
            onClick={() => dispatch({ type: 'undo' })}
          >
            ↺
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Redo"
            disabled={!canRedo}
            onClick={() => dispatch({ type: 'redo' })}
          >
            ↻
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Toggle dark mode"
            onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
          >
            {theme === 'light' ? '☾' : '☀'}
          </Button>
        </div>
      </header>

      <main className="stage">
        <div className="stage__canvas">
          {empty ? (
            <div className="stage__empty">
              <EmptyState
                icon="◳"
                title="Nothing drawn yet"
                description="Add your survey points and the boundary, area and dimensions will appear here."
                actions={
                  <>
                    <Button variant="primary" onClick={() => openPanel('data')}>
                      Add points
                    </Button>
                    <Button onClick={() => openPanel('ai')}>Ask AI</Button>
                  </>
                }
              />
            </div>
          ) : (
            <DrawingCanvas
              drawing={drawing ?? { layers: [], bounds: { min: { easting: 0, northing: 0 }, max: { easting: 0, northing: 0 } } }}
              labelsForScale={labelsForScale}
              previews={previews}
              selectedId={state.selectedId}
              highlightId={state.highlightId}
              showLabels={showLabels}
              showGrid={showGrid}
              tool={tool}
              unit={UNIT_ABBREVIATION[state.model.crs.units]}
              onDrawPoint={(at) => dispatch({ type: 'add-boundary-point', at })}
              onSelect={(id) => dispatch({ type: 'select', id })}
            />
          )}

          {!pipeline.ok ? (
            <FadeIn className="stage__banner">
              <div className="banner">
                <span className="banner__text">{pipeline.message}</span>
                <Button size="sm" variant="secondary" onClick={() => openPanel('validation')}>
                  Review
                </Button>
              </div>
            </FadeIn>
          ) : null}
        </div>

        {/* Above 1024px the assistant is always visible beside the drawing. */}
        <aside className="stage__rail">
          <AISheet onOpenPanel={openPanel} onSelectTool={setTool} />
        </aside>
      </main>

      <ContextualToolbar
        selectedId={state.selectedId}
        onClear={() => dispatch({ type: 'select', id: null })}
        onOpenProperties={() => openPanel('properties')}
      />

      {/* B.3: the tool row sits between the drawing and the tab bar. */}
      <div className="toolbar" role="toolbar" aria-label="Drawing tools">
        <Segmented
          ariaLabel="Drawing tool"
          value={tool}
          onChange={(next) => {
            setTool(next);
            // Leaving select mode clears the selection, so the contextual
            // toolbar does not linger over a tool it has nothing to do with.
            if (next !== 'select') dispatch({ type: 'select', id: null });
          }}
          options={[
            { value: 'select', label: 'Select' },
            { value: 'draw', label: 'Draw' },
            { value: 'measure', label: 'Measure' },
          ]}
        />
      </div>

      <nav className="tabbar" aria-label="Main">
        <TabButton label="Assistant" glyph="✦" onClick={() => openPanel('ai')} />
        <TabButton label="Data" glyph="≡" onClick={() => openPanel('data')} />
        <TabButton label="Layers" glyph="◱" onClick={() => openPanel('layers')} />
        <TabButton label="Export" glyph="↥" onClick={() => openPanel('export')} />
      </nav>

      {/* --- Sheets --------------------------------------------------------- */}

      <BottomSheet
        open={panel === 'ai'}
        onClose={() => setPanel(null)}
        title="Site Plan Assistant"
        subtitle="Grounded in your survey data"
        size="tall"
      >
        <AISheet onOpenPanel={openPanel} onSelectTool={setTool} />
      </BottomSheet>

      <BottomSheet
        open={panel === 'data'}
        onClose={() => setPanel(null)}
        title="Survey data"
        subtitle="Points, coordinates and the reference system"
        size="full"
      >
        <DataSheet onClose={() => setPanel(null)} />
      </BottomSheet>

      <BottomSheet
        open={panel === 'validation'}
        onClose={() => setPanel(null)}
        title="Check the drawing"
        subtitle="Everything we found, in plain language"
        size="tall"
      >
        <ValidationSheet onOpenData={() => setPanel('data')} />
      </BottomSheet>

      <BottomSheet
        open={panel === 'export'}
        onClose={() => setPanel(null)}
        title="Export"
        size="full"
      >
        <ExportDialog onClose={() => setPanel(null)} />
      </BottomSheet>

      <BottomSheet
        open={panel === 'properties'}
        onClose={() => setPanel(null)}
        title="Properties"
        subtitle={state.selectedId ?? undefined}
      >
        <PropertiesSheet
          element={state.selectedId ? selectedElement(pipeline, state.selectedId) : undefined}
          onClose={() => setPanel(null)}
        />
      </BottomSheet>

      <BottomSheet open={panel === 'layers'} onClose={() => setPanel(null)} title="Layers">
        <div className="layers">
          <Toggle label="Labels" checked={showLabels} onChange={setShowLabels} />
          <Toggle label="Grid" checked={showGrid} onChange={setShowGrid} />
        </div>
      </BottomSheet>

      <BottomSheet
        open={panel === 'project'}
        onClose={() => setPanel(null)}
        title="Project"
        subtitle="The site, the rules it is drawn under, and starting again"
      >
        <ProjectSheet
          onClose={() => setPanel(null)}
          onNewProject={() => {
            setPanel(null);
            setToast('Started a new, empty project. Undo if that was a mistake.');
          }}
        />
      </BottomSheet>

      {toast ? (
        <div className="workspace__toasts">
          <Toast
            message={toast}
            action={{
              label: 'Undo',
              onClick: () => {
                dispatch({ type: 'undo' });
                setToast(null);
              },
            }}
            onDismiss={() => setToast(null)}
          />
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function TabButton({
  label,
  glyph,
  onClick,
}: {
  readonly label: string;
  readonly glyph: string;
  readonly onClick: () => void;
}) {
  return (
    <button type="button" className="tabbar__button" onClick={onClick}>
      <span className="tabbar__glyph" aria-hidden="true">
        {glyph}
      </span>
      <span className="tabbar__label">{label}</span>
    </button>
  );
}

/**
 * B.15: the toolbar shows only what applies to the current selection. Nothing
 * selected offers the drawing tools; a selected object offers its own actions.
 */
function ContextualToolbar({
  selectedId,
  onClear,
  onOpenProperties,
}: {
  readonly selectedId: string | null;
  readonly onClear: () => void;
  readonly onOpenProperties: () => void;
}) {
  const { pipeline, dispatch } = useProject();
  if (!selectedId) return null;

  const element = selectedElement(pipeline, selectedId);
  const kind =
    element?.subject.kind === 'segment'
      ? 'Boundary line'
      : element?.subject.kind === 'point'
        ? 'Survey point'
        : element?.subject.kind === 'feature'
          ? 'Feature'
          : 'Selection';

  return (
    <FadeIn className="contextbar">
      <div className="contextbar__inner">
        <span className="contextbar__title">
          {kind}
          <span className="contextbar__id numeric">{selectedId}</span>
        </span>
        <div className="contextbar__actions">
          <Button size="sm" onClick={onOpenProperties}>
            Properties
          </Button>
          {/* Only offer deletion for things that can be deleted on their own. */}
          {element?.subject.kind === 'feature' ? (
            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                if (element.subject.kind !== 'feature') return;
                dispatch({ type: 'remove-feature', id: element.subject.featureId });
              }}
            >
              Delete
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={onClear} aria-label="Clear selection">
            ✕
          </Button>
        </div>
      </div>
    </FadeIn>
  );
}

function selectedElement(
  pipeline: ReturnType<typeof useProject>['pipeline'],
  id: string,
) {
  return (pipeline.drawing?.layers ?? [])
    .flatMap((layer) => layer.elements)
    .find((element) => element.id === id);
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (value: boolean) => void;
}) {
  return (
    <label className="toggle">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="toggle__track" aria-hidden="true">
        <span className="toggle__thumb" />
      </span>
    </label>
  );
}

function buildWorkflow(
  pointCount: number,
  featureCount: number,
  status: 'ready' | 'needs-review' | 'error',
): readonly Step[] {
  const done = (condition: boolean): Step['state'] => (condition ? 'complete' : 'pending');

  return [
    { ...WORKFLOW[0]!, state: done(pointCount >= 3) },
    { ...WORKFLOW[1]!, state: done(pointCount >= 3) },
    { ...WORKFLOW[2]!, state: featureCount > 0 ? 'complete' : 'active' },
    { ...WORKFLOW[3]!, state: done(featureCount > 1) },
    { ...WORKFLOW[4]!, state: done(pointCount >= 3) },
    {
      ...WORKFLOW[5]!,
      state: status === 'error' ? 'failed' : status === 'ready' ? 'complete' : 'active',
    },
    { ...WORKFLOW[6]!, state: status === 'ready' ? 'active' : 'pending' },
  ];
}
