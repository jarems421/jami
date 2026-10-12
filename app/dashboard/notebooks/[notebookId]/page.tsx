"use client";

import { useParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import JamiAssistantDrawer from "@/components/ai/JamiAssistantDrawer";
import { useUser } from "@/components/providers/UserProvider";
import type { NotebookInkEditorHandle } from "@/components/workspace/NotebookInkEditor";
import NotebookAddPagesDialog from "@/components/workspace/NotebookAddPagesDialog";
import NotebookCreatePageAffordance from "@/components/workspace/NotebookCreatePageAffordance";
import NotebookDrawingToolbar from "@/components/workspace/NotebookDrawingToolbar";
import NotebookEditorConfirmDialog from "@/components/workspace/NotebookEditorConfirmDialog";
import NotebookEditorFallback from "@/components/workspace/NotebookEditorFallback";
import NotebookEditorHeader from "@/components/workspace/NotebookEditorHeader";
import NotebookFeedbackNotice from "@/components/workspace/NotebookFeedbackNotice";
import NotebookLassoLayer from "@/components/workspace/NotebookLassoLayer";
import NotebookFloatingNotices from "@/components/workspace/NotebookFloatingNotices";
import NotebookGraphEditorDialog from "@/components/workspace/NotebookGraphEditorDialog";
import NotebookGraphLayer from "@/components/workspace/NotebookGraphLayer";
import NotebookImageLayer from "@/components/workspace/NotebookImageLayer";
import NotebookLivePageLayers from "@/components/workspace/NotebookLivePageLayers";
import { PAGE_COLOR_CLASS } from "@/components/workspace/NotebookPageBackground";
import NotebookPageNavigation from "@/components/workspace/NotebookPageNavigation";
import NotebookPagesDrawer from "@/components/workspace/NotebookPagesDrawer";
import NotebookPhoneLayoutNotice from "@/components/workspace/NotebookPhoneLayoutNotice";
import NotebookQuestionOverlay from "@/components/workspace/NotebookQuestionOverlay";
import NotebookSheetsLayer, {
  useNotebookSheetsBeside,
} from "@/components/workspace/NotebookSheetsBeside";
import { getNotebookSwipePreviews } from "@/components/workspace/NotebookSwipePreviews";
import NotebookTextBlockLayer from "@/components/workspace/NotebookTextBlockLayer";
import NotebookToolSettingsPopover from "@/components/workspace/NotebookToolSettingsPopover";
import NotebookViewport from "@/components/workspace/NotebookViewport";
import { useFeedback } from "@/hooks/useFeedback";
import { NOTEBOOK_PHONE_LAYOUT_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";
import { useNotebookActivePage } from "@/hooks/useNotebookActivePage";
import { useNotebookAssistantContext } from "@/hooks/useNotebookAssistantContext";
import { useNotebookEditorShell, useNotebookPageUrl } from "@/hooks/useNotebookEditorShell";
import { useNotebookExitGuard } from "@/hooks/useNotebookExitGuard";
import { useNotebookInkController } from "@/hooks/useNotebookInkController";
import { useNotebookInkEditorEvents } from "@/hooks/useNotebookInkEditorEvents";
import { useNotebookInteractionGuards } from "@/hooks/useNotebookInteractionGuards";
import { useNotebookKeyboardShortcuts } from "@/hooks/useNotebookKeyboardShortcuts";
import { useNotebookLiveInkLayer } from "@/hooks/useNotebookLiveInkLayer";
import { useNotebookLoader } from "@/hooks/useNotebookLoader";
import { useNotebookPageHydration } from "@/hooks/useNotebookPageHydration";
import { useNotebookPageManagement } from "@/hooks/useNotebookPageManagement";
import { getNotebookPointFromEvent, useNotebookPagePointer } from "@/hooks/useNotebookPagePointer";
import { useNotebookPageState } from "@/hooks/useNotebookPageState";
import { useNotebookPageTrack } from "@/hooks/useNotebookPageTrack";
import { useNotebookNavigationLock, useNotebookPageTurn } from "@/hooks/useNotebookPageTurn";
import { useNotebookPersistenceController } from "@/hooks/useNotebookPersistenceController";
import { useNotebookPlacedItems } from "@/hooks/useNotebookPlacedItems";
import { useNotebookSwipeGesture } from "@/hooks/useNotebookSwipeGesture";
import { useNotebookTextBlockController } from "@/hooks/useNotebookTextBlockController";
import { useNotebookDrawingToolbar } from "@/hooks/useNotebookDrawingToolbar";
import { useNotebookToolSettings } from "@/hooks/useNotebookToolSettings";
import { useNotebookTouchInkHint } from "@/hooks/useNotebookTouchInkHint";
import { useNotebookTutorBridge } from "@/hooks/useNotebookTutorBridge";
import { useNotebookViewportController } from "@/hooks/useNotebookViewportController";
import {
  useNotebookDrawingToolState,
  useNotebookNavigationState,
  useNotebookPageCreationState,
  useNotebookPanelState,
} from "@/hooks/useNotebookWorkspaceState";
import { usePracticePaperRetake } from "@/hooks/usePracticePaperRetake";
import { usePracticePaperStatus } from "@/hooks/usePracticePaperStatus";
import { featureFlags } from "@/lib/app/feature-flags";
import { notebookPageHasWork } from "@/lib/workspace/notebook-assistant";
import { notebookInkSvg } from "@/lib/workspace/notebook-ink-data";
import {
  clampNotebookPagePan,
  shouldSuppressTouchAfterStylus,
} from "@/lib/workspace/notebook-inking";
import { pageHasSavedInk } from "@/lib/workspace/notebook-page-ink-split";
import { notebookToolMovesPlacedItems } from "@/lib/workspace/notebook-page-state";
import {
  type NotebookPdfCanvasTracking,
} from "@/lib/workspace/notebook-pdf-canvas";
import {
  applyNotebookPageSave,
  applyNotebookPreviewFromSave,
  type NotebookPageSaveResult,
} from "@/lib/workspace/notebook-save-result";
import {
  NOTEBOOK_PAGE_COORDINATE_HEIGHT,
  NOTEBOOK_PAGE_COORDINATE_WIDTH,
} from "@/lib/workspace/notebooks";

const CANVAS_WIDTH = NOTEBOOK_PAGE_COORDINATE_WIDTH;
const CANVAS_HEIGHT = NOTEBOOK_PAGE_COORDINATE_HEIGHT;

/**
 * The notebook editor, as the composition root for its controllers.
 *
 * Each concern lives in its own hook -- loading, the shared page store, ink,
 * autosave, placed items, text boxes, tools, page turns and swipes -- and this
 * component creates them in the order they depend on one another, routes the
 * page's pointer input between them, and lays out what they render.
 *
 * A few controllers call one another in a loop (ink marks the page unsaved, a
 * pinch cancels a swipe, a load resets the viewport), so the earlier ones are
 * handed callbacks that reach the later ones; every controller keeps its
 * callbacks behind a ref, so they are only ever called after this has run.
 */
export default function NotebookEditorPage() {
  const { user } = useUser();
  const userId = user.uid;
  const params = useParams<{ notebookId?: string | string[] }>();
  const notebookId = Array.isArray(params.notebookId) ? params.notebookId[0] : params.notebookId;
  // Shared page state lives in one store so its committed value and its
  // render value cannot drift. Read it with `pageState.read()` inside handlers.
  const { store: pageState, state: pageSnapshot } = useNotebookPageState();
  const { textBlocks, pageColor, pageStyle, saveStatus, tool } = pageSnapshot;
  const {
    feedback,
    show: showFeedback,
    success,
    showError,
    showThrownError,
    clear: clearFeedback,
    clearIfShowing: clearFeedbackIfShowing,
  } = useFeedback();

  // Plain editor state, declared before the controllers that read and write it.
  const drawingTools = useNotebookDrawingToolState();
  const {
    penColor, highlighterColor, eraserWidth,
    openMenu: openToolMenu, closeMenus: closeDrawingToolMenus,
  } = drawingTools;
  const {
    pageZoom, setPageZoom, pagePan, setPagePan,
    frameSize, setFrameSize, pageSwipeMotion, setPageSwipeMotion,
    pageSwipeInkSnapshot, setPageSwipeInkSnapshot,
  } = useNotebookNavigationState();
  const creation = useNotebookPageCreationState();
  const {
    createPageActive, createPageProgress, creatingPage, createPageBounce,
    inkEditorMountRevision, setInkEditorMountRevision,
  } = creation;
  const {
    assistantOpen, setAssistantOpen, pagesDrawerOpen, setPagesDrawerOpen,
    phoneFullEditing, setPhoneFullEditing,
  } = useNotebookPanelState();
  const isPhoneLayout = useMediaQuery(NOTEBOOK_PHONE_LAYOUT_QUERY);
  const fullNotebookEditingEnabled = !isPhoneLayout || phoneFullEditing;
  const inkEditorRef = useRef<NotebookInkEditorHandle | null>(null);
  /** Bumped on every edit; save results older than the newest are discarded. */
  const editorRevisionRef = useRef(0);
  const pageFrameRef = useRef<HTMLDivElement | null>(null);
  const pageTrackRef = useRef<HTMLDivElement | null>(null);
  const pagePreviewLayerRef = useRef<HTMLDivElement | null>(null);
  const pageSurfaceRef = useRef<HTMLDivElement | null>(null);
  const createPageAffordanceRef = useRef<HTMLDivElement | null>(null);
  const createPageIndicatorRef = useRef<HTMLDivElement | null>(null);
  const createPageProgressCircleRef = useRef<SVGCircleElement | null>(null);
  const activePdfCanvasTrackingRef = useRef<NotebookPdfCanvasTracking<HTMLCanvasElement>>({
    canvas: null,
    renderKey: null,
  });
  const navigationLock = useNotebookNavigationLock();
  const { swipeRef: pageSwipeRef, isLocked: isPageNavigationLocked } = navigationLock;

  const loader = useNotebookLoader({
    userId,
    notebookId,
    pageState,
    onFeedback: showFeedback,
    onBeforeLoad: () => {
      viewport.resetViewportGestures();
      setPageZoom(1);
      setPagePan({ x: 0, y: 0 });
      editorRevisionRef.current = 0;
      persistence.resetSaveTracking();
    },
    onDraftRestored: () => setInkEditorMountRevision((current) => current + 1),
  });
  const {
    notebook,
    setNotebook,
    pages,
    setPages,
    files,
    fileUrls,
    selectedPageId,
    loading,
    loadFailed,
    takeRecoveredDraft,
    reload: reloadNotebook,
  } = loader;

  const sheetsBeside = useNotebookSheetsBeside({
    notebookId: notebookId ?? "",
    userId,
    folderId: notebook?.folderId ?? "",
    files,
  });

  const {
    selectedPage,
    selectedPageIndex,
    selectedPageInkUnloaded,
    selectedPageInk,
    selectedPageInkSvg,
    activeNotebookFile,
    activeNotebookFileUrl,
    activePdfRenderKey,
    resolvePageBackground,
    trackPreviousPage,
    trackNextPage,
  } = useNotebookActivePage({
    notebook,
    pages,
    selectedPageId,
    files,
    fileUrls,
    swipeMotion: pageSwipeMotion,
  });

  const ink = useNotebookInkController({
    pageState,
    inkEditorRef,
    onEdit: (options) => persistence.markPageUnsaved(options),
    resetTextBlockInteraction: () => resetTextBlockInteraction(),
    onUiCommitted: () => clearFeedbackIfShowing("Could not autosave this page."),
  });
  const {
    inkReadyRef,
    inkInteractionActiveRef,
    stylusInteractionRef,
    stylusCooldownUntilRef,
    inkReady,
    inkHasContent,
    undoDepth,
    redoDepth,
    setInkReady,
    isInteracting: isInkInteracting,
    recordTextEdit,
    clearInk: clearPageInk,
    handleInkChange,
    handleInkHistoryChange,
    handleInteractionChange: handleInkInteractionChange,
    commitUi: flushInkUiSync,
    scheduleUiCommit: scheduleInkUiSync,
    cancelUiCommit: cancelInkUiSync,
  } = ink;

  const { practicePaperStatus, handlePracticePaperStatusChange } =
    usePracticePaperStatus(setAssistantOpen);
  const [practicePaperEditingLocked, setPracticePaperEditingLocked] = useState(false);
  const [practicePaperTutorLocked, setPracticePaperTutorLocked] = useState(false);
  const handlePracticePaperRetake = usePracticePaperRetake(pageState, setPages, setInkEditorMountRevision);
  const pageEditingEnabled = fullNotebookEditingEnabled && !practicePaperEditingLocked;

  const pageHasWork = notebookPageHasWork({ page: selectedPage, textBlocks, inkHasContent });

  // Asked from pointer handlers only, never while rendering.
  const isStylusSuppressingTouch = useCallback(
    () =>
      shouldSuppressTouchAfterStylus({
        stylusActive: stylusInteractionRef.current,
        cooldownUntil: stylusCooldownUntilRef.current,
        now: Date.now(),
      }),
    [stylusCooldownUntilRef, stylusInteractionRef]
  );

  const viewport = useNotebookViewportController({
    frameSize,
    pageZoom,
    pagePan,
    pageWidth: CANVAS_WIDTH,
    pageHeight: CANVAS_HEIGHT,
    setPageZoom,
    setPagePan,
    pageSurfaceRef,
    pageFrameRef,
    isNavigationLocked: isPageNavigationLocked,
    isStylusSuppressingTouch,
    onPinchTakeover: () => turn.cancelSwipeForPinch(),
    onClearSwipeCandidate: () => {
      pageSwipeRef.current = null;
    },
    onSwipeEnd: (event, options) => swipe.end(event, options),
    nativeScroll: featureFlags.enableNotebookNativeScroll,
  });
  const {
    layout: viewportLayout,
    pageFit,
    pageWidthPx,
    pageHeightPx,
    pageTrackTravelDistance,
    pagePanLiveRef,
    isPinchActive,
    cancelPinchAnimationFrame: cancelPinchZoomAnimationFrame,
    cancelActivePinch,
    handleTouchPointerDown,
    handleTouchPointerMove,
    handleTouchPointerEnd,
  } = viewport;

  const track = useNotebookPageTrack({
    trackRef: pageTrackRef,
    previewLayerRef: pagePreviewLayerRef,
    createPageAffordanceRef,
    createPageIndicatorRef,
    createPageProgressCircleRef,
    getSelectedPageId: () => pageState.read().selectedPage?.id ?? null,
    // Prepared while the page was idle, so beginning a swipe does not pay for
    // an SVG export on the pointermove that starts it.
    getInkSnapshotSvg: () => notebookInkSvg(inkEditorRef.current?.serializeWarm()) ?? selectedPageInkSvg,
    onSwipeMotionChange: setPageSwipeMotion,
    onInkSnapshotChange: setPageSwipeInkSnapshot,
  });

  const getNotebookAssistantContext = useNotebookAssistantContext({
    pageState,
    notebook,
    selectedPageId: selectedPage?.id,
    activeNotebookFile,
    activePdfRenderKey,
    activePdfCanvasTrackingRef,
    inkEditorRef,
    inkReadyRef,
    inkInteractionActiveRef,
    editorRevisionRef,
  });

  useEffect(() => {
    activePdfCanvasTrackingRef.current = { canvas: null, renderKey: null };
  }, [activePdfRenderKey]);

  useNotebookPageUrl(selectedPage?.id);

  // The frame mounts once the notebook has loaded, so measuring restarts then.
  useEffect(() => {
    const frame = pageFrameRef.current;
    if (!frame || typeof window === "undefined") return;

    const updateFrameSize = () => {
      const rect = frame.getBoundingClientRect();
      setFrameSize((previous) =>
        Math.abs(previous.width - rect.width) < 0.5 &&
        Math.abs(previous.height - rect.height) < 0.5
          ? previous
          : { width: rect.width, height: rect.height }
      );
    };

    updateFrameSize();
    const observer = new ResizeObserver(updateFrameSize);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [loading, notebook?.id, setFrameSize]);

  // Keep the committed pan valid whenever the zoom or frame changes: centered
  // at fit zoom, and otherwise held inside the frame wherever the reader left it.
  useEffect(() => {
    setPagePan((previous) => {
      const next = clampNotebookPagePan({
        pan: previous,
        pageWidth: pageWidthPx,
        pageHeight: pageHeightPx,
        frameWidth: frameSize.width,
        frameHeight: frameSize.height,
        zoom: viewportLayout.zoom,
      });
      return next.x === previous.x && next.y === previous.y ? previous : next;
    });
  }, [frameSize, pageHeightPx, pageWidthPx, setPagePan, viewportLayout.zoom]);

  useEffect(() => {
    pagePanLiveRef.current = pagePan;
  }, [pagePan, pagePanLiveRef]);

  const handlePageSaved = useCallback(
    (result: NotebookPageSaveResult) => {
      setPages((current) =>
        current.map((page) => (page.id === result.pageId ? applyNotebookPageSave(page, result) : page))
      );
      setNotebook((current) => (current ? applyNotebookPreviewFromSave(current, result) : current));
    },
    [setNotebook, setPages]
  );

  const persistence = useNotebookPersistenceController({
    pageState,
    userId,
    inkEditorRef,
    editorRevisionRef,
    isInkInteracting,
    fallbackInk: selectedPageInk,
    onPageSaved: handlePageSaved,
    onError: showError,
    onClearError: clearFeedbackIfShowing,
    commitUi: flushInkUiSync,
    scheduleUiCommit: scheduleInkUiSync,
  });
  const {
    markPageUnsaved,
    saveCurrentPage,
    schedulePendingWork,
    cancelScheduledWork: cancelScheduledPersistence,
  } = persistence;

  const {
    imageLayerProps,
    graphLayerProps,
    graphEditorTarget,
    setGraphEditorTarget,
    addingImage,
    clearSelection: clearPlacedItemSelection,
    currentImageRefsFor,
    currentGraphBlocksFor,
    handleIllustrationInserted,
    handleAddImage,
    handleOpenNewGraph,
    handleSaveGraph,
    handleTutorGraphInsert,
    lasso,
    undo: handleUndo,
    redo: handleRedo,
  } = useNotebookPlacedItems({
    userId,
    notebookId,
    pageState,
    setPages,
    openPageId: selectedPage?.id,
    tool,
    isPhoneLayout,
    closeToolMenus: closeDrawingToolMenus,
    success,
    showError,
    showThrownError,
    shared: { inkEditorRef, history: ink, markUnsaved: markPageUnsaved },
  });
  const placedItemsEditingEnabled =
    notebookToolMovesPlacedItems(tool) && pageEditingEnabled && !isPhoneLayout;

  // With js-draw as the single ink engine, switching tools only updates the
  // desired style; NotebookInkEditor defers applying it while a pointer is
  // still down, so no flush/commit step is needed.
  const switchNotebookTool = pageState.setTool;

  const cancelCompetingPageGestures = useCallback(() => {
    pageSwipeRef.current = null;
    cancelActivePinch();
  }, [cancelActivePinch, pageSwipeRef]);

  const handleTextBlockLimitReached = useCallback((maximum: number) => {
    showError(`A page can contain up to ${maximum} text boxes. Move or delete one before adding another.`);
  }, [showError]);

  const handleTextBlockCreated = useCallback(() => {
    // The text tool places exactly one box per activation.
    switchNotebookTool("select");
  }, [switchNotebookTool]);

  const {
    layerProps: textBlockLayerProps,
    selectedTextBlockId,
    editingTextBlockId,
    openTextBlockOptionsId,
    activeTextGestureId,
    resetTextBlockInteraction,
    finishActiveTextBlockGesture,
    clearTextBlockSelection,
    createTextBlockAtPoint,
    insertTextBlock,
    handlePageSurfaceTextGestureMove,
    handlePageSurfaceTextGestureStop,
  } = useNotebookTextBlockController({
    editingEnabled: fullNotebookEditingEnabled,
    isNavigationLocked: isPageNavigationLocked,
    pageState,
    pageSurfaceRef,
    onChange: markPageUnsaved,
    onHistoryCommit: recordTextEdit,
    onGestureStart: cancelCompetingPageGestures,
    onCreateLimitReached: handleTextBlockLimitReached,
    onCreateComplete: handleTextBlockCreated,
    onTouchPointerDown: handleTouchPointerDown,
    onTouchPointerMove: handleTouchPointerMove,
    onTouchPointerEnd: handleTouchPointerEnd,
  });

  const {
    quickActions: notebookAssistantQuickActions,
    handleAssistantOpenChange,
    handleTutorAnswerInsert,
  } = useNotebookTutorBridge({
    userId,
    notebook,
    pageState,
    assistantOpen,
    setAssistantOpen,
    setPagesDrawerOpen,
    closeDrawingToolMenus,
    practicePaperStatus,
    pageHasWork,
    pageEditingEnabled,
    currentImageRefsFor,
    currentGraphBlocksFor,
    insertTextBlock,
    showError,
    success,
  });

  /**
   * Nothing on the page is selected any more.
   *
   * A page holds three kinds of placed thing -- text boxes, images and graphs
   * -- and they were being let go of in different places and at different
   * times. Tapping the page dropped a text box and left an image selected with
   * its handles up, because the only thing tapping away called was the text
   * controller's own clear. Selection is one idea to the person doing it, so
   * there is one way to end it.
   */
  const clearPlacedSelection = useCallback(() => {
    /*
     * Only what is actually selected. A pen calls this as it lands, on every
     * stroke, and setting state to the value it already holds is not free:
     * straight after any other update -- the undo buttons catching up with the
     * last stroke, say -- React renders this whole page once to find out that
     * nothing changed, in the moment the next stroke is starting.
     */
    if (
      selectedTextBlockId !== null ||
      editingTextBlockId !== null ||
      openTextBlockOptionsId !== null
    ) {
      clearTextBlockSelection();
    }
    clearPlacedItemSelection();
  }, [
    clearPlacedItemSelection,
    clearTextBlockSelection,
    editingTextBlockId,
    openTextBlockOptionsId,
    selectedTextBlockId,
  ]);

  const {
    confirmRequest,
    deletingPageId,
    requestDeletePage,
    requestClearPage,
    dismissRequest,
    confirmPendingRequest,
    openAddPages,
    addPagesDialog,
  } = useNotebookPageManagement({
    userId,
    notebook,
    pages,
    pageState,
    loader,
    saveCurrentPage,
    editingEnabled: fullNotebookEditingEnabled,
    clearPageInk,
    resetTextBlockInteraction,
    feedback: { success, showError, showThrownError, clear: clearFeedback },
  });

  const {
    handleSelectDrawingTool,
    handleToggleTool,
    pen: penToolSettings,
    highlighter: highlighterToolSettings,
    eraser: eraserToolSettings,
  } = useNotebookToolSettings({
    tools: drawingTools,
    pageColor,
    pageState,
    inkEditorRef,
    inkHasContent,
    clearPlacedSelection,
    onRequestClearPage: requestClearPage,
  });

  const turn = useNotebookPageTurn({
    userId,
    notebook,
    pages,
    selectedPageIndex,
    pageState,
    lock: navigationLock,
    loader,
    persistence,
    ink,
    track,
    viewport: { pageTrackTravelDistance, cancelActivePinch, frameSize },
    creation,
    background: {
      active: { file: activeNotebookFile, url: activeNotebookFileUrl },
      resolve: resolvePageBackground,
    },
    onError: showThrownError,
  });
  const {
    prepareForNavigation,
    selectPageById,
    turnByOffset,
    createPageAtEnd,
    interrupt: interruptPageTurn,
    requestHandoffCheck,
    markBackgroundSettled,
    handleBackgroundRenderStateChange,
  } = turn;

  const announceRecoveredDraft = useCallback(() => {
    success("Recovered unsaved work from this device. Syncing it now.");
  }, [success]);
  const remountInkEditor = useCallback(() => {
    setInkEditorMountRevision((current) => current + 1);
  }, [setInkEditorMountRevision]);

  useNotebookPageHydration({
    selectedPage,
    notebook,
    pageState,
    ink,
    inkEditorRef,
    persistence,
    editorRevisionRef,
    takeRecoveredDraft,
    resetTextBlockInteraction,
    onDraftRecovered: announceRecoveredDraft,
    onHydrated: requestHandoffCheck,
    remountInkEditor,
  });

  useNotebookEditorShell();

  useNotebookInteractionGuards({
    finishActiveTextBlockGesture,
    stylusInteractionRef,
    stylusCooldownUntilRef,
    cancelActivePinch,
    cancelPinchZoomAnimationFrame,
    setPagePan,
    pagePanLiveRef,
    interruptPageTurn,
    pageSurfaceRef,
    readySurfacePageId: selectedPage?.id && pageFit.width > 0 ? selectedPage.id : null,
    inkInteractionActiveRef,
  });

  const { handleExitNotebook, handleRetryPageSave } = useNotebookExitGuard({
    pageState,
    saveStatus,
    persistence,
    isInkInteracting,
    cancelInkUiCommit: cancelInkUiSync,
    showError,
  });

  const createTextBlockAtEvent = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const point = getNotebookPointFromEvent(event);
      if (point) createTextBlockAtPoint(point);
    },
    [createTextBlockAtPoint]
  );

  /** A tap that never moved: with the text tool in hand, a box goes there. */
  const handlePageTap = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (tool === "text") createTextBlockAtEvent(event);
    },
    [createTextBlockAtEvent, tool]
  );

  const swipe = useNotebookSwipeGesture({
    enabled: fullNotebookEditingEnabled && !activeTextGestureId,
    lock: navigationLock,
    turn,
    track,
    creation,
    viewport,
    pages,
    selectedPageIndex,
    pageSurfaceRef,
    inkInteractionActiveRef,
    onTap: handlePageTap,
  });

  const { visible: touchInkHintVisible, noteIgnoredTouch } = useNotebookTouchInkHint({
    enabled: fullNotebookEditingEnabled,
    tool,
    zoom: viewportLayout.zoom,
    isPinchActive,
    stylusCooldownUntilRef,
    swipeRef: pageSwipeRef,
  });

  const {
    handleFramePointerDown,
    handlePagePointerDown,
    handlePagePointerMove,
    handlePagePointerUp,
    handlePagePointerCancel,
  } = useNotebookPagePointer({
    enabled: fullNotebookEditingEnabled,
    lock: navigationLock,
    tool,
    closeToolMenus: closeDrawingToolMenus,
    clearPlacedSelection,
    viewport,
    swipe,
    createTextBlockAtEvent,
    noteIgnoredTouch,
  });

  useNotebookKeyboardShortcuts({
    enabled: fullNotebookEditingEnabled,
    readTool: () => pageState.read().tool,
    switchTool: switchNotebookTool,
    undo: handleUndo,
    redo: handleRedo,
    onEscape: () => {
      if (closeDrawingToolMenus()) return "menu";
      clearPlacedSelection();
    },
  });

  const handleSelectPageFromDrawer = useCallback(
    (pageId: string) => {
      setPagesDrawerOpen(false);
      void selectPageById(pageId);
    },
    [selectPageById, setPagesDrawerOpen]
  );

  const handleCreatePageFromDrawer = useCallback(() => {
    void createPageAtEnd();
  }, [createPageAtEnd]);

  const { dock: toolbarDock, topBarRef, toolbarProps: drawingToolbarProps } = useNotebookDrawingToolbar({
    frameRef: pageFrameRef,
    frameSize,
    closeMenus: closeDrawingToolMenus,
    drawingTools,
    undo: handleUndo,
    redo: handleRedo,
    tool,
    penColor,
    highlighterColor,
    openMenu: openToolMenu,
    onSelectDrawingTool: handleSelectDrawingTool,
    onToggleTool: handleToggleTool,
    onAddImage: handleAddImage,
    addingImage,
    onAddGraph: handleOpenNewGraph,
    undoDepth,
    redoDepth,
  });

  const inkEditorEvents = useNotebookInkEditorEvents({
    pageState,
    inkReadyRef,
    setInkReady,
    requestHandoffCheck,
    showError,
    handleInkInteractionChange,
    closeDrawingToolMenus,
    pagesDrawerOpen,
    setPagesDrawerOpen,
    clearPlacedSelection,
    cancelInkUiSync,
    scheduleInkUiSync,
    cancelScheduledPersistence,
    schedulePendingWork,
  });

  const { backgroundProps: liveBackgroundProps, inkEditorProps: liveInkEditorProps } =
    useNotebookLiveInkLayer({
      page: selectedPage,
      paper: { pageColor, pageStyle },
      background: {
        file: activeNotebookFile,
        url: activeNotebookFileUrl,
        pdfRenderKey: activePdfRenderKey,
        onImageSettled: markBackgroundSettled,
        onPdfRenderStateChange: handleBackgroundRenderStateChange,
        pdfCanvasTrackingRef: activePdfCanvasTrackingRef,
      },
      handingOff: pageSwipeMotion?.phase === "handoff",
      viewport,
      tool,
      tools: drawingTools,
      ink: {
        ...inkEditorEvents,
        onChange: handleInkChange,
        onHistoryChange: handleInkHistoryChange,
      },
      pointer: {
        onPointerDown: handlePagePointerDown,
        onPointerMove: handlePagePointerMove,
        onPointerUp: handlePagePointerUp,
        onPointerCancel: handlePagePointerCancel,
      },
    });

  if (loading || !notebook) {
    return (
      <NotebookEditorFallback
        state={loading ? "loading" : loadFailed ? "failed" : "missing"}
        onRetry={() => void reloadNotebook()}
      />
    );
  }

  const swipePreviews = getNotebookSwipePreviews({
    zoom: viewportLayout.zoom,
    notebook,
    previousPage: trackPreviousPage,
    nextPage: trackNextPage,
    resolveBackground: resolvePageBackground,
    paper: { pageColor, pageStyle },
    newPage: {
      createPageActive,
      creatingPage,
      motionKind: pageSwipeMotion?.kind ?? null,
      fullEditingEnabled: fullNotebookEditingEnabled,
      selectedPageIndex,
      pageCount: pages.length,
    },
  });

  return (
    <main
      data-app-surface="true"
      data-testid="notebook-editor"
      data-notebook-id={notebook.id}
      data-notebook-selected-page-id={selectedPage?.id ?? ""}
      data-notebook-ink-ready={inkReady ? "true" : "false"}
      data-notebook-has-ink={inkHasContent ? "true" : "false"}
      className="notebook-editor-shell fixed inset-0 z-[70] flex min-w-0 flex-col overflow-hidden bg-[var(--color-surface-base)] text-text-primary"
    >
      <div className="flex h-full min-h-0 flex-col">
        <NotebookEditorHeader
          notebook={notebook}
          userId={userId}
          saveStatus={saveStatus}
          onRetrySave={handleRetryPageSave}
          onExit={handleExitNotebook}
          pagesDrawerOpen={pagesDrawerOpen}
          onTogglePages={() => {
            closeDrawingToolMenus();
            const nextOpen = !pagesDrawerOpen;
            setPagesDrawerOpen(nextOpen);
            if (nextOpen) handleAssistantOpenChange(false);
          }}
          tutorLocked={practicePaperTutorLocked}
          sheets={sheetsBeside}
          assistantOpen={assistantOpen}
          onToggleAssistant={() => handleAssistantOpenChange(!assistantOpen)}
          practicePaper={{
            onStatusChange: handlePracticePaperStatusChange,
            onBeforeSubmit: prepareForNavigation,
            onRetake: handlePracticePaperRetake,
            onEditingLockChange: setPracticePaperEditingLocked,
            onTutorLockChange: setPracticePaperTutorLocked,
          }}
          tools={pageEditingEnabled && toolbarDock === "top" ? <NotebookDrawingToolbar {...drawingToolbarProps} /> : null}
          barRef={topBarRef}
        />
        <div className="relative isolate min-h-0 flex-1 overflow-hidden">
          <NotebookToolSettingsPopover
            dock={toolbarDock === "top" ? "top-bar" : toolbarDock}
            openMenu={openToolMenu}
            pen={penToolSettings}
            highlighter={highlighterToolSettings}
            eraser={eraserToolSettings}
          />

          <NotebookFeedbackNotice feedback={feedback} onDismiss={() => clearFeedback()} />

          <NotebookAddPagesDialog {...addPagesDialog} />

          <NotebookPhoneLayoutNotice
            open={isPhoneLayout}
            fullEditing={phoneFullEditing}
            onToggleFullEditing={() => setPhoneFullEditing((value) => !value)}
          />

          {!practicePaperTutorLocked ? (
            <JamiAssistantDrawer
              userId={userId}
              open={assistantOpen}
              onOpenChange={handleAssistantOpenChange}
              layout="floating"
              // Keep one conversation across page turns; the current page is
              // still resolved fresh for every message.
              resetKey={`notebook:${notebook.id}`}
              contextKey={`notebook:${notebook.id}`}
              contextLabel="Current notebook page"
              historyContextLabel={notebook.title}
              getContext={getNotebookAssistantContext}
              quickActions={notebookAssistantQuickActions}
              settingsFolderIds={notebook.folderId ? [notebook.folderId] : []}
              onBeforeIllustrationInsert={() => saveCurrentPage({ flush: true })}
              onIllustrationInserted={handleIllustrationInserted}
              onGraphInsert={handleTutorGraphInsert}
              onDrawingInsert={handleAddImage}
              onAnswerInsert={handleTutorAnswerInsert}
              onKeepAttachmentBeside={sheetsBeside.keepAttachment}
              onAddNotebookPages={pageEditingEnabled ? turn.appendBlankPages : undefined}
            />
          ) : null}
          <NotebookSheetsLayer sheets={sheetsBeside} hidden={practicePaperTutorLocked} />
          <NotebookGraphEditorDialog
            open={graphEditorTarget !== null}
            graph={selectedPage?.graphBlocks.find((graph) => graph.id === graphEditorTarget) ?? null}
            onCancel={() => setGraphEditorTarget(null)}
            onSave={handleSaveGraph}
          />
          {pagesDrawerOpen ? (
            <NotebookPagesDrawer
              pages={pages}
              notebook={notebook}
              selectedPageId={selectedPage?.id ?? null}
              deletingPageId={deletingPageId}
              editingEnabled={pageEditingEnabled}
              creatingPage={creatingPage}
              navigationBusy={Boolean(pageSwipeMotion)}
              resolvePageBackground={resolvePageBackground}
              onSelectPage={handleSelectPageFromDrawer}
              onCreatePage={handleCreatePageFromDrawer}
              onImportPages={openAddPages}
              onRequestDeletePage={requestDeletePage}
            />
          ) : null}

          <NotebookViewport
            onFramePointerDown={handleFramePointerDown}
            frameRef={pageFrameRef}
            trackRef={pageTrackRef}
            previewLayerRef={pagePreviewLayerRef}
            activeRef={pageSurfaceRef}
            {...viewport.viewportProps}
            previousPreview={swipePreviews.previous}
            nextPreview={swipePreviews.next}
            activeClassName={PAGE_COLOR_CLASS[pageColor]}
            onTrackTransitionEnd={track.handleTransitionEnd}
            onTrackTransitionCancel={track.handleTransitionEnd}
            onActivePointerMove={handlePageSurfaceTextGestureMove}
            onActivePointerUp={handlePageSurfaceTextGestureStop}
            onActivePointerCancel={handlePageSurfaceTextGestureStop}
            overlay={
              selectedPage ? (
                <NotebookQuestionOverlay page={selectedPage} />
              ) : null
            }
            activeContent={
              selectedPage && pageFit.width > 0 ? (
                <>
                  <NotebookLivePageLayers
                    pageId={selectedPage.id}
                    pageWidth={CANVAS_WIDTH}
                    pageHeight={CANVAS_HEIGHT}
                    persistedInk={selectedPageInk}
                    hasPersistedInk={pageHasSavedInk(selectedPage)}
                    inkReady={inkReady}
                    editingEnabled={pageEditingEnabled && !selectedPageInkUnloaded}
                    eraserWidth={eraserWidth}
                    inkEditorMountRevision={inkEditorMountRevision}
                    inkEditorRef={inkEditorRef}
                    swipeInkSnapshot={pageSwipeInkSnapshot}
                    onSwipeInkSnapshotReady={track.markInkSnapshotReady}
                    backgroundProps={liveBackgroundProps}
                    inkEditorProps={liveInkEditorProps}
                  />
                  <NotebookImageLayer
                    {...imageLayerProps}
                    images={selectedPage.imageRefs}
                    editingEnabled={placedItemsEditingEnabled}
                  />
                  <NotebookGraphLayer
                    {...graphLayerProps}
                    graphs={selectedPage.graphBlocks}
                    editingEnabled={placedItemsEditingEnabled}
                  />
                  <NotebookTextBlockLayer
                    {...textBlockLayerProps}
                    textBlocks={textBlocks}
                    pageColor={pageColor}
                    editingEnabled={pageEditingEnabled}
                  />
                  <NotebookLassoLayer lasso={lasso} page={liveInkEditorProps} />
                </>
              ) : null
            }
          />
          {createPageActive || creatingPage ? (
            <NotebookCreatePageAffordance
              affordanceRef={createPageAffordanceRef}
              indicatorRef={createPageIndicatorRef}
              progressCircleRef={createPageProgressCircleRef}
              progress={createPageProgress}
              creating={creatingPage}
              bounce={createPageBounce}
            />
          ) : null}
          {pageEditingEnabled && toolbarDock !== "top" ? <NotebookDrawingToolbar {...drawingToolbarProps} /> : null}
          <NotebookPageNavigation
            selectedPageIndex={selectedPageIndex}
            pageCount={pages.length}
            navigationBusy={Boolean(pageSwipeMotion)}
            editingToolbarVisible={pageEditingEnabled && toolbarDock === "bottom"}
            canCreatePage={
              selectedPageIndex >= 0 && selectedPageIndex >= pages.length - 1 && pageEditingEnabled
            }
            creatingPage={creatingPage}
            onPrevious={() => void turnByOffset(-1)}
            onNext={() => void turnByOffset(1)}
            onCreate={() => void createPageAtEnd()}
          />
          <NotebookFloatingNotices
            toolbarDock={toolbarDock}
            touchInkHint={touchInkHintVisible}
            inkLoading={selectedPageInkUnloaded && pageEditingEnabled}
          />
        </div>
      </div>
      <NotebookEditorConfirmDialog
        request={confirmRequest}
        busy={Boolean(deletingPageId)}
        onConfirm={confirmPendingRequest}
        onClose={dismissRequest}
      />
    </main>
  );
}
