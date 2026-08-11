/**
 * The main workspace (Architecture B.1, B.3, B.14, B.15).
 *
 * Visual hierarchy is enforced by layout: the drawing occupies everything that
 * is not chrome, and every panel is a sheet over it rather than a column beside
 * it. On a wide screen the assistant becomes a side rail — but the plan still
 * gets the majority of the pixels.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { contextFor, placeLabels, UNIT_ABBREVIATION, type LayerId } from '@surveyor/engine';

import { DrawingCanvas, type CanvasTool } from '../canvas/DrawingCanvas.js';
import { AddSheet } from '../panels/AddSheet.js';
import { ProjectsSheet } from '../panels/ProjectsSheet.js';
import { ProjectSheet } from '../panels/ProjectSheet.js';
import { ToolsSheet } from '../panels/ToolsSheet.js';
import { PropertiesSheet } from '../panels/PropertiesSheet.js';
import { Segmented } from '../ui/primitives.js';
import { AISheet } from '../ai/AISheet.js';
import { DataSheet } from '../panels/DataSheet.js';
import { ExportDialog } from '../panels/ExportDialog.js';
import { STATUS_LABEL, ValidationSheet } from '../panels/ValidationSheet.js';
import {
  BottomSheet,
  Button,
  Card,
  EmptyState,
  ProgressStepper,
  StatusBadge,
  Toast,
  type Step,
  type StatusTone,
} from '../ui/primitives.js';
import { ProfileSheet } from '../panels/ProfileSheet.js';
import { SavedSheet } from '../panels/SavedSheet.js';
import { ReportsSheet } from '../panels/ReportsSheet.js';
import { DocumentsSheet } from '../panels/DocumentsSheet.js';
import { SettingsSheet } from '../panels/SettingsSheet.js';
import { HelpSheet } from '../panels/HelpSheet.js';
import { Sidebar } from '../ui/Sidebar.js';
import { clearAllData, loadPreferences } from '../state/preferences.js';
import { FadeIn } from '../ui/motion.js';
import { useProject } from '../state/store.js';
import './workspace.css';

type Panel =
  | 'ai'
  | 'data'
  | 'validation'
  | 'export'
  | 'layers'
  | 'properties'
  | 'project'
  | 'tools'
  | 'add'
  | 'projects'
  | 'profile'
  | 'saved'
  | 'reports'
  | 'documents'
  | 'settings'
  | 'help'
  | null;

interface LayerState {
  readonly visible: boolean;
  readonly locked: boolean;
}

const LAYER_NAMES: readonly { readonly id: LayerId; readonly label: string }[] = [
  { id: 'boundary', label: 'Boundary' },
  { id: 'features', label: 'Site features' },
  { id: 'points', label: 'Survey points' },
  { id: 'dimensions', label: 'Dimensions' },
];

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
  /** Where the context menu is and what it was opened on. */
  const [menu, setMenu] = useState<
    { readonly x: number; readonly y: number; readonly id: string | null } | null
  >(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  /*
   * Seeded from the stored preferences rather than from constants. These were
   * chosen afresh on every visit — the theme most visibly — which reads as the
   * app not paying attention rather than as a default.
   */
  const [preferences, setPreferences] = useState(() => loadPreferences());
  const [showLabels, setShowLabels] = useState(preferences.showLabels);
  const [showGrid, setShowGrid] = useState(preferences.showGrid);
  const [theme, setTheme] = useState<'light' | 'dark'>(preferences.theme);
  const [tool, setTool] = useState<CanvasTool>('select');
  const [snapping, setSnapping] = useState(preferences.snapping);
  /**
   * Which layers are shown, and which are held still.
   *
   * Two separate ideas that a single toggle would blur. Hiding takes a layer
   * out of the way; locking leaves it in view to work against — a boundary you
   * are fitting a building to — while making it impossible to nudge by
   * accident. A surveyor who has to hide the boundary to stop moving it has
   * lost the thing they were aligning to.
   */
  const [layers, setLayers] = useState<Readonly<Record<LayerId, LayerState>>>({
    boundary: { visible: true, locked: false },
    features: { visible: true, locked: false },
    points: { visible: true, locked: false },
    dimensions: { visible: true, locked: false },
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Keyboard shortcuts on desktop; the mobile UI reaches the same actions
  // through the toolbar, so nothing is keyboard-only.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Typing in a field is not a shortcut.
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      if (event.metaKey || event.ctrlKey) {
        if (event.key === 'z' && !event.shiftKey) {
          event.preventDefault();
          dispatch({ type: 'undo' });
        } else if ((event.key === 'z' && event.shiftKey) || event.key === 'y') {
          event.preventDefault();
          dispatch({ type: 'redo' });
        }
        return;
      }

      // The drawer closes itself on Escape. Letting this handler run as well
      // would also drop the selection and reset the tool, which is a lot to
      // happen behind a menu the user was only dismissing.
      if (event.key === 'Escape' && menuOpen) return;

      // The single-key shortcuts a drafter's left hand expects. Deliberately
      // few: every one of them has to be unambiguous, because a stray key
      // press over a drawing should never change the survey.
      switch (event.key) {
        case 'Escape':
          setMenu(null);
          setPanel(null);
          setTool('select');
          dispatch({ type: 'select', id: null });
          return;
        case 'Delete':
        case 'Backspace':
          if (state.selectedIds.length > 0) {
            event.preventDefault();
            dispatch({ type: 'delete-selection' });
          }
          return;
        case 'm':
          setTool('measure');
          return;
        case 'd':
          setTool('draw');
          return;
        case 'i':
          setTool('dimension');
          return;
        case 'v':
          setTool('select');
          return;
        case 'e':
          setPanel('tools');
          return;
        case 'a':
          setPanel('add');
          return;
        case 'f':
          setSnapping((on) => !on);
          return;
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch, menuOpen, state.selectedIds.length]);

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
        {/*
          The menu button. First in the header and first in the tab order,
          which is where a hand and a screen reader both look for it.
        */}
        <button
          type="button"
          className="topbar__menu"
          aria-label="Open menu"
          aria-expanded={menuOpen}
          aria-haspopup="dialog"
          title="Menu"
          onClick={() => setMenuOpen(true)}
        >
          ☰
        </button>

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
            title="Project settings, revisions and new project"
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
            title="Undo (Ctrl+Z)"
            disabled={!canUndo}
            onClick={() => dispatch({ type: 'undo' })}
          >
            ↺
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Redo"
            title="Redo (Ctrl+Shift+Z)"
            disabled={!canRedo}
            onClick={() => dispatch({ type: 'redo' })}
          >
            ↻
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Toggle dark mode"
            title="Switch between light and dark"
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
              selectedIds={state.selectedIds}
              onSelectMany={(ids, additive) =>
                dispatch(
                  additive
                    ? { type: 'select-many', ids: [...state.selectedIds, ...ids] }
                    : { type: 'select-many', ids },
                )
              }
              snapping={snapping}
              {...(showGrid ? { gridSpacing: 5 } : {})}
              highlightId={state.highlightId}
              showLabels={showLabels}
              showGrid={showGrid}
              tool={tool}
              unit={UNIT_ABBREVIATION[state.model.crs.units]}
              onDrawPoint={(at) => dispatch({ type: 'add-boundary-point', at })}
              onSelect={(id) => dispatch({ type: 'select', id })}
              hiddenLayers={LAYER_NAMES.filter((l) => !layers[l.id].visible).map((l) => l.id)}
              lockedLayers={LAYER_NAMES.filter((l) => layers[l.id].locked).map((l) => l.id)}
              onMoveBy={(by) => dispatch({ type: 'transform', transform: { kind: 'move', by } })}
              onPlaceDimension={(from, to) => dispatch({ type: 'add-dimension', from, to })}
              onContextMenu={(at, id) => {
                // Right-clicking an unselected object selects it first, which
                // is what every drawing program does and what makes the menu's
                // actions mean something.
                if (id !== null && !state.selectedIds.includes(id)) {
                  dispatch({ type: 'select', id });
                }
                setMenu({ ...at, id });
              }}
            />
          )}

          {/*
            An empty project is not a broken one. The pipeline rightly declines
            to draw nothing, but a red banner reading "there is nothing to draw
            yet" on a blank sheet tells someone they have done something wrong
            at the exact moment they have done the right thing — and the empty
            state beside it is already saying the same thing, helpfully.
          */}
          {!pipeline.ok && !nothingYet ? (
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
        selectedIds={state.selectedIds}
        onOpenTools={() => openPanel('tools')}
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
            { value: 'dimension', label: 'Dimension' },
          ]}
        />

        {/*
          Add and Edit are panels rather than modes, so they are buttons rather
          than segments — mixing them into the mode picker would say that
          "Edit" is a state the canvas can be in, which it is not.

          They belong here because until now they had no button at all: Add was
          reachable only by pressing `A`, and Edit only by selecting something
          first or pressing `E`. On a phone, which has neither key, the whole
          palette of drawing tools was effectively invisible.
        */}
        <div className="toolbar__actions">
          <Button size="sm" onClick={() => openPanel('add')} title="Add to the drawing (A)">
            + Add
          </Button>
          {/*
            "Modify" rather than "Edit", because the contextual bar over the
            drawing already says Edit about the current selection. Two buttons
            reading the same word, on screen together, doing the same thing, is
            a thing to guess at. Modify is also what a CAD user is looking for.
          */}
          <Button
            size="sm"
            onClick={() => openPanel('tools')}
            title="Move, rotate, scale, mirror, offset, array, chamfer (E)"
          >
            Modify
          </Button>
        </div>
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

      <BottomSheet
        open={panel === 'layers'}
        onClose={() => setPanel(null)}
        title="Layers"
        subtitle="What is drawn, and what is held still"
      >
        <div className="layers">
          {LAYER_NAMES.map(({ id, label }) => (
            <div key={id} className="layers__row">
              <span className="layers__name">{label}</span>
              <div className="layers__controls">
                <LayerToggle
                  label={`Show ${label.toLowerCase()}`}
                  glyph={layers[id].visible ? '👁' : '⃠'}
                  on={layers[id].visible}
                  onClick={() =>
                    setLayers((current) => ({
                      ...current,
                      [id]: { ...current[id], visible: !current[id].visible },
                    }))
                  }
                />
                <LayerToggle
                  label={`Lock ${label.toLowerCase()}`}
                  glyph={layers[id].locked ? '🔒' : '🔓'}
                  on={layers[id].locked}
                  onClick={() =>
                    setLayers((current) => ({
                      ...current,
                      [id]: { ...current[id], locked: !current[id].locked },
                    }))
                  }
                />
              </div>
            </div>
          ))}

          <hr className="layers__rule" />

          <Toggle label="Labels" checked={showLabels} onChange={setShowLabels} />
          <Toggle label="Grid" checked={showGrid} onChange={setShowGrid} />
          <Toggle label="Snapping" checked={snapping} onChange={setSnapping} />
        </div>
      </BottomSheet>

      <BottomSheet
        open={panel === 'projects'}
        onClose={() => setPanel(null)}
        title="Projects"
        subtitle="Every survey you have saved, with its history"
        size="full"
      >
        <ProjectsSheet onClose={() => setPanel(null)} />
      </BottomSheet>

      <BottomSheet
        open={panel === 'add'}
        onClose={() => setPanel(null)}
        title="Add to the drawing"
        subtitle="Buildings, fences, walls, trees, levels and notes"
      >
        <AddSheet onClose={() => setPanel(null)} />
      </BottomSheet>

      <BottomSheet
        open={panel === 'tools'}
        onClose={() => setPanel(null)}
        title="Modify"
        subtitle="Move, rotate, scale, mirror, offset, array and chamfer — by exact amounts"
      >
        <ToolsSheet onClose={() => setPanel(null)} />
      </BottomSheet>

      <BottomSheet
        open={panel === 'project'}
        onClose={() => setPanel(null)}
        title="Project"
        subtitle="The site, the rules it is drawn under, and starting again"
      >
        <ProjectSheet
          onClose={() => setPanel(null)}
          onOpenLibrary={() => setPanel('projects')}
          onNewProject={() => {
            setPanel(null);
            setToast('Started a new project. The last one is saved in Projects.');
          }}
        />
      </BottomSheet>

      <BottomSheet
        open={panel === 'profile'}
        onClose={() => setPanel(null)}
        title="Profile"
        subtitle="Who is drawing, for the title block"
      >
        <ProfileSheet onClose={() => setPanel(null)} />
      </BottomSheet>

      <BottomSheet
        open={panel === 'saved'}
        onClose={() => setPanel(null)}
        title="Saved"
        subtitle="The projects you keep to hand"
        size="tall"
      >
        <SavedSheet onClose={() => setPanel(null)} onOpenLibrary={() => setPanel('projects')} />
      </BottomSheet>

      <BottomSheet
        open={panel === 'reports'}
        onClose={() => setPanel(null)}
        title="Reports"
        subtitle="The survey written out, from the same figures as the plan"
        size="full"
      >
        <ReportsSheet onClose={() => setPanel(null)} />
      </BottomSheet>

      <BottomSheet
        open={panel === 'documents'}
        onClose={() => setPanel(null)}
        title="Documents"
        subtitle="Deeds, briefs and field notes kept with this project"
        size="tall"
      >
        <DocumentsSheet onClose={() => setPanel(null)} />
      </BottomSheet>

      <BottomSheet
        open={panel === 'settings'}
        onClose={() => setPanel(null)}
        title="Settings"
        subtitle="Defaults, and what this browser is holding"
        size="tall"
      >
        <SettingsSheet
          onClose={() => setPanel(null)}
          onChanged={(next) => {
            // Applied at once rather than on the next reload: a preference
            // that takes effect later is one the user assumes did not work.
            setPreferences(next);
            setTheme(next.theme);
            setSnapping(next.snapping);
            setShowGrid(next.showGrid);
            setShowLabels(next.showLabels);
          }}
        />
      </BottomSheet>

      <BottomSheet
        open={panel === 'help'}
        onClose={() => setPanel(null)}
        title="Help"
        subtitle="How to do things, and what the numbers mean"
        size="tall"
      >
        <HelpSheet onClose={() => setPanel(null)} />
      </BottomSheet>

      {/*
        Signing out of a device rather than out of an account — there is no
        account. On a shared site tablet, leaving your surveys on it is the
        real risk, so this is what "sign out" can honestly mean here. It is
        destructive, so it says exactly what goes before it goes.
      */}
      <BottomSheet
        open={signingOut}
        onClose={() => setSigningOut(false)}
        title="Log out of this device"
      >
        <div className="panel">
          <Card tone="sunken">
            <p className="panel__body">
              This app has no account to log out of — everything is stored in this
              browser. Logging out therefore means removing it from this device:
              every project, its version history, its documents and your profile.
            </p>
          </Card>
          <p className="panel__body">
            Export anything you need first. This cannot be undone and there is no
            copy anywhere else.
          </p>
          <div className="panel__footer panel__footer--stacked">
            <Button
              full
              variant="danger"
              onClick={() => {
                clearAllData();
                window.location.reload();
              }}
            >
              Log out and erase this device
            </Button>
            <Button full variant="primary" onClick={() => setSigningOut(false)}>
              Stay logged in
            </Button>
          </div>
        </div>
      </BottomSheet>

      {/*
        The navigation drawer. It reaches the panels the app already has by the
        same route everything else does — a panel name — rather than bringing
        a second navigation model with it.
      */}
      <Sidebar
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        activeId={activeSection(panel)}
        subtitle={state.model.metadata.siteAddress ?? 'Untitled plan'}
        onNavigate={(item) => {
          setMenuOpen(false);
          if (item.target.kind === 'panel') setPanel(item.target.panel);
          // The drawing is what the sheets sit on top of, so getting back to
          // it means dismissing them.
          else if (item.target.kind === 'canvas') setPanel(null);
          else setSigningOut(true);
        }}
      />

      {menu ? (
        <ContextMenu
          at={menu}
          onClose={() => setMenu(null)}
          items={
            state.selectedIds.length > 0
              ? [
                  { label: 'Edit…', hint: 'E', run: () => setPanel('tools') },
                  ...(state.selectedId
                    ? [{ label: 'Properties', run: () => setPanel('properties') }]
                    : []),
                  {
                    label: 'Duplicate',
                    // A copy on top of the original cannot be seen or grabbed,
                    // so it lands a couple of metres away where it can be.
                    run: () =>
                      dispatch({ type: 'duplicate-selection', by: { de: 2, dn: -2 } }),
                  },
                  {
                    label: 'Delete',
                    hint: '⌫',
                    danger: true,
                    run: () => dispatch({ type: 'delete-selection' }),
                  },
                  {
                    label: 'Clear selection',
                    hint: 'Esc',
                    run: () => dispatch({ type: 'select', id: null }),
                  },
                ]
              : [
                  { label: 'Add to the drawing…', hint: 'A', run: () => setPanel('add') },
                  { label: 'Place a dimension', hint: 'I', run: () => setTool('dimension') },
                  { label: 'Measure', hint: 'M', run: () => setTool('measure') },
                  {
                    label: snapping ? 'Turn snapping off' : 'Turn snapping on',
                    hint: 'F',
                    run: () => setSnapping((on) => !on),
                  },
                  { label: 'Survey data…', run: () => setPanel('data') },
                ]
          }
        />
      ) : null}

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
  selectedIds,
  onOpenTools,
  onClear,
  onOpenProperties,
}: {
  readonly selectedId: string | null;
  readonly selectedIds: readonly string[];
  readonly onOpenTools: () => void;
  readonly onClear: () => void;
  readonly onOpenProperties: () => void;
}) {
  const { pipeline, dispatch } = useProject();
  if (selectedIds.length === 0) return null;

  // A multi-selection has no single element to describe, but it is exactly
  // when the editing tools matter most — so the bar appears either way.
  const element = selectedId ? selectedElement(pipeline, selectedId) : undefined;
  // Dimension elements are named `dim_…_line` / `_witness_from` / `_witness_to`
  // and all share the boundary-segment subject shape, so the id is what tells
  // them apart from a real boundary line.
  const dimensionId = selectedId?.startsWith('dim_')
    ? selectedId.replace(/_(line|witness_from|witness_to)$/, '')
    : null;

  const kind = dimensionId
    ? 'Dimension'
    : element?.subject.kind === 'segment'
      ? 'Boundary line'
      : element?.subject.kind === 'point'
        ? 'Survey point'
        : element?.subject.kind === 'feature'
          ? 'Feature'
          : `${selectedIds.length} objects`;

  return (
    <FadeIn className="contextbar">
      <div className="contextbar__inner">
        <span className="contextbar__title">
          {kind}
          {selectedId ? (
            <span className="contextbar__id numeric">{selectedId}</span>
          ) : null}
        </span>
        <div className="contextbar__actions">
          <Button size="sm" variant="primary" onClick={onOpenTools}>
            Edit
          </Button>
          {selectedId ? (
            <Button size="sm" onClick={onOpenProperties}>
              Properties
            </Button>
          ) : null}
          {/* Only offer deletion for things that can be deleted on their own. */}
          {dimensionId ? (
            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                dispatch({ type: 'remove-dimension', id: dimensionId });
                onClear();
              }}
            >
              Delete
            </Button>
          ) : element?.subject.kind === 'feature' ? (
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
          <Button size="sm" variant="ghost" onClick={onClear} aria-label="Clear selection" title="Clear selection (Esc)">
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

interface MenuItem {
  readonly label: string;
  /** The keyboard shortcut that does the same thing, if there is one. */
  readonly hint?: string;
  readonly danger?: boolean;
  readonly run: () => void;
}

/**
 * The context menu.
 *
 * Reachable by right-click on a desktop and by holding a finger down on a
 * phone, which is the part that matters — on touch there is no other way to
 * get at these actions without hunting through panels.
 *
 * It shows the shortcut beside each item, so using it is also how you learn
 * not to need it.
 */
function ContextMenu({
  at,
  items,
  onClose,
}: {
  readonly at: { readonly x: number; readonly y: number };
  readonly items: readonly MenuItem[];
  readonly onClose: () => void;
}) {
  // Kept clear of the right and bottom edges, so a click near either does not
  // open a menu half off the screen.
  const left = Math.min(at.x, window.innerWidth - 220);
  const top = Math.min(at.y, window.innerHeight - (items.length * 40 + 24));

  return (
    <>
      {/*
        A full-screen catcher rather than a document listener: it closes the
        menu on the first click anywhere, and that click does not also fall
        through and do something on the drawing underneath.
      */}
      <div className="menu__scrim" onPointerDown={onClose} onContextMenu={(e) => e.preventDefault()} />
      <div className="menu" role="menu" style={{ left, top }}>
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className={`menu__item${item.danger ? ' menu__item--danger' : ''}`}
            onClick={() => {
              item.run();
              onClose();
            }}
          >
            <span>{item.label}</span>
            {item.hint ? <span className="menu__hint numeric">{item.hint}</span> : null}
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * One layer control: an icon button that says what it is doing.
 *
 * Icon-only, but never label-only to a screen reader — a row of eyes and
 * padlocks is legible at a glance and meaningless without the `aria-label`.
 */
function LayerToggle({
  label,
  glyph,
  on,
  onClick,
}: {
  readonly label: string;
  readonly glyph: string;
  readonly on: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`layers__button${on ? ' is-on' : ''}`}
      aria-label={label}
      aria-pressed={on}
      title={label}
      onClick={onClick}
    >
      <span aria-hidden="true">{glyph}</span>
    </button>
  );
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

/**
 * Which sidebar section the app is currently showing.
 *
 * Derived from the open panel rather than stored, so the highlight cannot fall
 * out of step with what is on screen. No panel means the drawing itself, which
 * is a section in its own right here.
 */
function activeSection(panel: Panel): string | null {
  switch (panel) {
    case null:
      return 'drawings';
    case 'ai':
      return 'ai';
    case 'projects':
      return 'projects';
    case 'tools':
      return 'tools';
    case 'profile':
    case 'saved':
    case 'reports':
    case 'documents':
    case 'settings':
    case 'help':
      return panel;
    default:
      // A panel with no sidebar entry — Data, Layers, Export and the rest are
      // reached from the tab bar, and marking a section they do not belong to
      // would point at the wrong thing.
      return null;
  }
}

function buildWorkflow(
  pointCount: number,
  featureCount: number,
  status: 'ready' | 'needs-review' | 'error',
): readonly Step[] {
  const done = (condition: boolean): Step['state'] => (condition ? 'complete' : 'pending');

  // Nothing drawn yet is the start of the work, not a failure of it. Without
  // this the first thing a new project shows is a red cross against Review,
  // and the step it is failing is one the user has not reached.
  const started = pointCount > 0;

  return [
    { ...WORKFLOW[0]!, state: done(pointCount >= 3) },
    { ...WORKFLOW[1]!, state: done(pointCount >= 3) },
    { ...WORKFLOW[2]!, state: featureCount > 0 ? 'complete' : started ? 'active' : 'pending' },
    { ...WORKFLOW[3]!, state: done(featureCount > 1) },
    { ...WORKFLOW[4]!, state: done(pointCount >= 3) },
    {
      ...WORKFLOW[5]!,
      state: !started
        ? 'pending'
        : status === 'error'
          ? 'failed'
          : status === 'ready'
            ? 'complete'
            : 'active',
    },
    { ...WORKFLOW[6]!, state: status === 'ready' ? 'active' : 'pending' },
  ];
}
