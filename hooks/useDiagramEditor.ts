"use client";

import { useCallback, useMemo, useReducer, useState } from "react";
import type { Card } from "@/lib/study/cards";
import type { DiagramPicture } from "@/lib/study/diagram-image";
import { labelsFromDetections } from "@/lib/study/diagram-label-detection";
import {
  MAX_DIAGRAM_GROUPS,
  MAX_DIAGRAM_LABELS,
  MAX_SHAPES_PER_LABEL,
  getDiagramDraftError,
  isWholeDiagramGroupId,
  type OcclusionCardStyle,
  type OcclusionCoverColor,
  type OcclusionLabel,
  type OcclusionLabelMode,
  type OcclusionPointer,
  type OcclusionShape,
} from "@/lib/study/image-occlusion";
import { cropLabels, moveShape, type OcclusionCrop } from "@/lib/study/image-occlusion-geometry";
import {
  createDiagramEditorState,
  diagramEditorReducer,
} from "@/lib/study/image-occlusion-editor";
import { detectDiagramLabels } from "@/services/ai/diagram-labels";
import { cardSaveErrorMessage } from "@/services/study/card-images";
import {
  deleteDiagram,
  saveDiagram,
  type DiagramPictureInput,
  type DiagramSaveResult,
} from "@/services/study/image-occlusion";

/**
 * `rect` and `ellipse` draw boxes, `outline` traces round a part freehand,
 * `pointer` draws a label's line, and `select` moves and resizes.
 */
export type DiagramTool = "rect" | "ellipse" | "outline" | "pointer";
export type DiagramSelection = { labelId: string; shapeIndex: number } | null;
/**
 * The picture being labelled, with its size in pixels. A new one carries a
 * local preview URL, made when it was chosen and released by `releasePicture`
 * or by the picture that replaces it.
 */
export type DiagramPictureState =
  | (Extract<DiagramPictureInput, { kind: "saved" }> & { width: number; height: number })
  | (Extract<DiagramPictureInput, { kind: "new" }> & { previewUrl: string });

function newPictureState(picture: DiagramPicture): DiagramPictureState {
  return { kind: "new", ...picture, previewUrl: URL.createObjectURL(picture.file) };
}

export const MIN_DIAGRAM_ZOOM = 1;
export const MAX_DIAGRAM_ZOOM = 4;

function newId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 12)
    : Math.random().toString(36).slice(2, 14);
}

type UseDiagramEditorOptions = {
  userId: string;
  deckId: string;
  /** The card the editor was opened from, when editing an existing diagram. */
  editing?: Card | null;
  /** A new diagram's picture, already prepared. */
  picture?: DiagramPicture | null;
};

/**
 * Everything the diagram editor holds, and every change it can make.
 *
 * The component draws; this decides. Mounted once per editing session -- the
 * dialog keys it -- so its starting values are read once and never re-synced.
 */
export function useDiagramEditor({
  userId,
  deckId,
  editing,
  picture: initialPicture,
}: UseDiagramEditorOptions) {
  const initialDiagram = editing?.occlusion?.diagram;
  const [picture, setPictureState] = useState<DiagramPictureState | null>(() => {
    const image = initialDiagram?.image;
    if (image) return { kind: "saved", image, width: image.width, height: image.height };
    return initialPicture ? newPictureState(initialPicture) : null;
  });
  /**
   * The picture as it was chosen, before any crop: a PDF page, a whole photo.
   * Kept so the next diagram can be cropped out of the same page.
   */
  const [sourcePicture, setSourcePicture] = useState<DiagramPicture | null>(initialPicture ?? null);
  /** Whether the diagram is a crop of its source: only then is there more of the page to use. */
  const [wasCropped, setWasCropped] = useState(false);
  const [history, dispatch] = useReducer(
    diagramEditorReducer,
    {
      labels: initialDiagram?.labels ?? [],
      // The whole-diagram group follows the card style; it is never edited as a group.
      groups: (initialDiagram?.groups ?? []).filter((group) => !isWholeDiagramGroupId(group.id)),
    },
    createDiagramEditorState
  );
  const [header, setHeader] = useState(editing?.front ?? "");
  const [labelMode, setLabelModeState] = useState<OcclusionLabelMode>(initialDiagram?.labelMode ?? "cover");
  const [hideOthers, setHideOthers] = useState(initialDiagram?.hideOthers ?? true);
  const [pointerEnd, setPointerEnd] = useState<"dot" | "arrow">(initialDiagram?.pointerEnd ?? "dot");
  const [coverColor, setCoverColor] = useState<OcclusionCoverColor | null>(initialDiagram?.coverColor ?? null);
  /*
   * A diagram is always one card. One saved as a card per label, before that
   * was settled, becomes one card when it is next saved. Several diagrams of
   * one picture are how a student gets more than one card from it.
   */
  const initialCardStyle: OcclusionCardStyle = initialDiagram ? initialDiagram.cardStyle ?? "each" : "whole";
  const cardStyle: OcclusionCardStyle = "whole";
  const [topicIds, setTopicIdsState] = useState<string[]>(editing?.topicIds ?? []);
  const [topicsChanged, setTopicsChanged] = useState(false);
  const [rawSelection, setSelection] = useState<DiagramSelection>(null);
  const [tool, setTool] = useState<DiagramTool>("rect");
  const [zoom, setZoomState] = useState(1);
  const [addingToLabelId, setAddingToLabelId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { labels, groups } = history.present;

  /** The Line tool belongs to naming parts, so covering labels puts it down. */
  const setLabelMode = useCallback((mode: OcclusionLabelMode) => {
    setLabelModeState(mode);
    if (mode !== "name") setTool((current) => (current === "pointer" ? "rect" : current));
  }, []);

  // A selection that undo took away is no selection at all.
  const selection = useMemo(() => {
    if (!rawSelection) return null;
    const label = labels.find((entry) => entry.id === rawSelection.labelId);
    return label?.shapes[rawSelection.shapeIndex] ? rawSelection : null;
  }, [labels, rawSelection]);
  const selectedLabel = selection ? labels.find((label) => label.id === selection.labelId) ?? null : null;

  /** A newly chosen picture. `asSource` when it was chosen whole, not cut from the last one. */
  const setPicture = useCallback(
    (next: DiagramPicture, options: { asSource?: boolean } = {}) => {
      if (picture?.kind === "new") URL.revokeObjectURL(picture.previewUrl);
      setPictureState(newPictureState(next));
      if (options.asSource) {
        setSourcePicture(next);
        setWasCropped(false);
      }
      setError(null);
    },
    [picture]
  );

  /** Frees the local preview. Call when the editor closes, however it closes. */
  const releasePicture = useCallback(() => {
    if (picture?.kind === "new") URL.revokeObjectURL(picture.previewUrl);
  }, [picture]);

  /** A cropped picture, with every box moved to match it. */
  const applyCrop = useCallback(
    (cropped: DiagramPicture, crop: OcclusionCrop) => {
      setPicture(cropped);
      setWasCropped(true);
      if (labels.length > 0) dispatch({ type: "replace-labels", labels: cropLabels(labels, crop) });
      setSelection(null);
    },
    [labels, setPicture]
  );

  /**
   * A shape the student just drew: a new label, or another box for the label
   * they asked to add to. Returns the label it went to.
   */
  const drawShape = useCallback(
    (shape: OcclusionShape): string | null => {
      const target = addingToLabelId ? labels.find((label) => label.id === addingToLabelId) : undefined;
      if (target && target.shapes.length < MAX_SHAPES_PER_LABEL) {
        dispatch({ type: "add-shape", labelId: target.id, shape });
        setSelection({ labelId: target.id, shapeIndex: target.shapes.length });
        setAddingToLabelId(null);
        return target.id;
      }
      setAddingToLabelId(null);
      if (labels.length >= MAX_DIAGRAM_LABELS) {
        setError(`A diagram can have up to ${MAX_DIAGRAM_LABELS} labels. Split it into two pictures.`);
        return null;
      }
      const label: OcclusionLabel = { id: newId(), answer: "", shapes: [shape] };
      dispatch({ type: "add-label", label });
      setSelection({ labelId: label.id, shapeIndex: 0 });
      setError(null);
      return label.id;
    },
    [addingToLabelId, labels]
  );

  const changeShape = useCallback(
    (labelId: string, shapeIndex: number, shape: OcclusionShape, gestureId?: string) => {
      dispatch({ type: "update-shape", labelId, shapeIndex, shape, gestureId });
    },
    []
  );

  const nudgeSelected = useCallback(
    (dx: number, dy: number) => {
      if (!selection || !selectedLabel) return;
      const shape = selectedLabel.shapes[selection.shapeIndex];
      dispatch({
        type: "update-shape",
        labelId: selection.labelId,
        shapeIndex: selection.shapeIndex,
        shape: moveShape(shape, dx, dy),
      });
    },
    [selectedLabel, selection]
  );

  const removeSelectedShape = useCallback(() => {
    if (!selection) return;
    dispatch({ type: "remove-shape", labelId: selection.labelId, shapeIndex: selection.shapeIndex });
    setSelection(null);
  }, [selection]);

  const removeLabel = useCallback((labelId: string) => {
    dispatch({ type: "remove-label", labelId });
    setSelection((current) => (current?.labelId === labelId ? null : current));
    setAddingToLabelId((current) => (current === labelId ? null : current));
  }, []);

  const setAnswer = useCallback((labelId: string, answer: string) => {
    dispatch({ type: "set-answer", labelId, answer });
  }, []);

  const setAccepts = useCallback((labelId: string, accepts: string[]) => {
    dispatch({ type: "set-accepts", labelId, accepts });
  }, []);

  const setNote = useCallback((labelId: string, note: string) => {
    dispatch({ type: "set-note", labelId, note });
  }, []);

  const selectLabel = useCallback(
    (labelId: string) => setSelection({ labelId, shapeIndex: 0 }),
    []
  );

  const startAddingBox = useCallback((labelId: string) => {
    setAddingToLabelId(labelId);
    setTool((current) => (current === "rect" || current === "ellipse" || current === "outline" ? current : "rect"));
  }, []);

  const setPointer = useCallback(
    (labelId: string, pointer: OcclusionPointer | null, gestureId?: string) => {
      dispatch({ type: "set-pointer", labelId, pointer, gestureId });
    },
    []
  );

  /** Select a label and pick up the Line tool, so the next tap says where it points. */
  const startPointing = useCallback((labelId: string) => {
    setSelection({ labelId, shapeIndex: 0 });
    setAddingToLabelId(null);
    setTool("pointer");
  }, []);

  /** A new group, starting with the selected label when there is one. */
  const addGroup = useCallback(() => {
    if (groups.length >= MAX_DIAGRAM_GROUPS) {
      setError(`A diagram can have up to ${MAX_DIAGRAM_GROUPS} groups.`);
      return;
    }
    dispatch({
      type: "add-group",
      group: { id: newId(), name: "", labelIds: selection ? [selection.labelId] : [] },
    });
  }, [groups.length, selection]);

  const setGroupName = useCallback((groupId: string, name: string) => {
    dispatch({ type: "set-group-name", groupId, name });
  }, []);

  const toggleGroupLabel = useCallback((groupId: string, labelId: string) => {
    dispatch({ type: "toggle-group-label", groupId, labelId });
  }, []);

  const removeGroup = useCallback((groupId: string) => {
    dispatch({ type: "remove-group", groupId });
  }, []);

  const setZoom = useCallback((next: number) => {
    setZoomState(Math.min(MAX_DIAGRAM_ZOOM, Math.max(MIN_DIAGRAM_ZOOM, Math.round(next * 4) / 4)));
  }, []);

  const setTopicIds = useCallback((next: string[]) => {
    setTopicIdsState(next);
    setTopicsChanged(true);
  }, []);

  /**
   * Ask Jami to find the printed labels and box them.
   *
   * Only ever on the student's say-so, one picture, once. The picture goes to
   * the AI provider for this request; nothing about it is kept except the
   * boxes the student keeps. Found labels are added in one step, so a single
   * undo takes them all back.
   */
  const detectLabels = useCallback(async () => {
    if (!picture || detecting) return;
    setDetecting(true);
    setError(null);
    setNotice(null);
    try {
      const detections = await detectDiagramLabels(
        picture.kind === "new" ? { kind: "file", file: picture.file } : { kind: "stored", storagePath: picture.image.storagePath }
      );
      const found = labelsFromDetections(detections, labels, newId).slice(0, MAX_DIAGRAM_LABELS - labels.length);
      if (found.length === 0) {
        setNotice(
          detections.length === 0
            ? "Jami could not find any printed labels on this picture. Draw the boxes by hand."
            : "Every label Jami found is already covered."
        );
        return;
      }
      setLabelMode("cover");
      dispatch({ type: "add-labels", labels: found });
      setSelection(null);
      setNotice(
        `Jami covered ${found.length} label${found.length === 1 ? "" : "s"}. Fix any box that is off, then save.`
      );
    } catch (detectError) {
      console.error("Failed to find diagram labels.", detectError);
      setError(detectError instanceof Error && detectError.message ? detectError.message : "Jami could not read the labels just now.");
    } finally {
      setDetecting(false);
    }
  }, [detecting, labels, picture, setLabelMode]);

  const pictureChanged = picture?.kind === "new" && Boolean(initialDiagram);
  const settingsChanged =
    header !== (editing?.front ?? "") ||
    labelMode !== (initialDiagram?.labelMode ?? "cover") ||
    hideOthers !== (initialDiagram?.hideOthers ?? true) ||
    pointerEnd !== (initialDiagram?.pointerEnd ?? "dot") ||
    coverColor !== (initialDiagram?.coverColor ?? null) ||
    cardStyle !== initialCardStyle ||
    topicsChanged;
  const dirty = history.past.length > 0 || settingsChanged || pictureChanged || (!initialDiagram && Boolean(picture));
  const draftError = getDiagramDraftError({ labelMode, labels, groups });

  const save = useCallback(async (): Promise<DiagramSaveResult | null> => {
    if (!picture) return null;
    if (draftError) {
      setError(draftError);
      return null;
    }
    setSaving(true);
    setError(null);
    try {
      return await saveDiagram({
        userId,
        deckId: editing?.deckId ?? deckId,
        diagramId: initialDiagram?.id,
        header,
        // An existing diagram keeps card-by-card topics unless they were changed here.
        topicIds: !initialDiagram || topicsChanged ? topicIds : undefined,
        picture,
        labelMode,
        hideOthers,
        pointerEnd,
        cardStyle,
        ...(coverColor ? { coverColor } : {}),
        labels,
        groups,
      });
    } catch (saveError) {
      console.error("Failed to save diagram.", saveError);
      setError(
        cardSaveErrorMessage(
          saveError,
          saveError instanceof Error && saveError.message ? saveError.message : "The diagram could not be saved."
        )
      );
      return null;
    } finally {
      setSaving(false);
    }
  }, [
    deckId,
    cardStyle,
    coverColor,
    draftError,
    editing?.deckId,
    groups,
    header,
    hideOthers,
    initialDiagram,
    labelMode,
    labels,
    picture,
    pointerEnd,
    topicIds,
    topicsChanged,
    userId,
  ]);

  const remove = useCallback(async (): Promise<string[] | null> => {
    if (!initialDiagram) return null;
    setDeleting(true);
    setError(null);
    try {
      return await deleteDiagram(userId, initialDiagram.id);
    } catch (deleteError) {
      console.error("Failed to delete diagram.", deleteError);
      setError("The diagram could not be deleted.");
      return null;
    } finally {
      setDeleting(false);
    }
  }, [initialDiagram, userId]);

  return {
    isExisting: Boolean(initialDiagram),
    picture,
    /** The whole picture a crop was taken from, when there was one. */
    sourcePicture: wasCropped ? sourcePicture : null,
    setPicture,
    releasePicture,
    applyCrop,
    labels,
    groups,
    header,
    setHeader,
    labelMode,
    setLabelMode,
    hideOthers,
    setHideOthers,
    pointerEnd,
    setPointerEnd,
    /** The covers' colour, or null for the theme's accent. */
    coverColor,
    setCoverColor,
    cardStyle,
    /** Whether saving will replace this diagram's cards, and with them their review history. */
    cardStyleChanged: Boolean(initialDiagram) && cardStyle !== initialCardStyle,
    topicIds,
    setTopicIds,
    selection,
    selectedLabel,
    setSelection,
    selectLabel,
    tool,
    setTool,
    zoom,
    setZoom,
    addingToLabelId,
    startAddingBox,
    cancelAddingBox: () => setAddingToLabelId(null),
    drawShape,
    changeShape,
    nudgeSelected,
    removeSelectedShape,
    removeLabel,
    setAnswer,
    setAccepts,
    setNote,
    setPointer,
    startPointing,
    addGroup,
    setGroupName,
    toggleGroupLabel,
    removeGroup,
    detecting,
    detectLabels,
    notice,
    dismissNotice: () => setNotice(null),
    undo: () => dispatch({ type: "undo" }),
    redo: () => dispatch({ type: "redo" }),
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    dirty,
    draftError,
    error,
    setError,
    saving,
    deleting,
    save,
    remove,
  };
}

export type DiagramEditorController = ReturnType<typeof useDiagramEditor>;
