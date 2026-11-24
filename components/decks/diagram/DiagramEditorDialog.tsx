"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { OcclusionPicture } from "@/components/cards/OcclusionFigure";
import DiagramCanvas from "@/components/decks/diagram/DiagramCanvas";
import DiagramCoverColorMenu from "@/components/decks/diagram/DiagramCoverColorMenu";
import DiagramCropStage from "@/components/decks/diagram/DiagramCropStage";
import DiagramLabelPanel, { diagramLabelFieldId } from "@/components/decks/diagram/DiagramLabelPanel";
import DiagramPictureSource from "@/components/decks/diagram/DiagramPictureSource";
import ToolbarIconButton from "@/components/workspace/NotebookToolbarIconButton";
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogBackdrop,
  DialogDescription,
  DialogPanel,
  DialogTitle,
  JamiTutorIcon,
  StudyText,
} from "@/components/ui";
import { useDiagramEditor, type DiagramEditorController } from "@/hooks/useDiagramEditor";
import { useDiagramPictureUrl } from "@/hooks/useDiagramPictureUrl";
import { featureFlags } from "@/lib/app/feature-flags";
import type { Topic } from "@/lib/material/topics";
import type { Card } from "@/lib/study/cards";
import { cropDiagramPicture, type DiagramPicture } from "@/lib/study/diagram-image";
import {
  getDiagramTargets,
  groupsForCardStyle,
  getOcclusionMasks,
  getOcclusionPrompt,
  getOcclusionTargets,
  getRevealedAnswerWords,
  occlusionCoverClass,
  type CardOcclusion,
  type OcclusionDiagram,
} from "@/lib/study/image-occlusion";
import type { OcclusionCrop } from "@/lib/study/image-occlusion-geometry";
import type { DiagramSaveResult } from "@/services/study/image-occlusion";

type Step = "picture" | "crop" | "kind" | "label";

export type DiagramEditorStart =
  | { kind: "new"; picture?: DiagramPicture; next?: "label" | "crop" }
  | { kind: "edit"; card: Card };

type DiagramEditorDialogProps = {
  /** What to open, or null for closed. */
  start: DiagramEditorStart | null;
  userId: string;
  /** Where a new diagram's cards go. An existing diagram's new labels join the deck of the card it was opened from. */
  deckId: string;
  deckName: string;
  topics: Topic[];
  onTopicsChange: (topics: Topic[]) => void;
  onClose: () => void;
  /**
   * `sourcePicture` is the picture as it was chosen, before any crop -- a PDF
   * page, a whole photo -- so another diagram can be cut from it next.
   */
  onSaved: (result: DiagramSaveResult, extra: { sourcePicture: DiagramPicture | null }) => void;
  onDeleted?: (cardIds: string[]) => void;
};

const FULL_CROP: OcclusionCrop = { x: 0, y: 0, width: 1, height: 1 };

function isFullCrop(crop: OcclusionCrop) {
  return crop.x <= 0.001 && crop.y <= 0.001 && crop.width >= 0.998 && crop.height >= 0.998;
}

function isTextField(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

/**
 * Making or editing a diagram card: picture, crop, boxes, labels, save.
 *
 * Full screen on a phone and nearly so elsewhere, because the picture is the
 * work surface and wants all the room it can get. Every session is mounted
 * fresh, so nothing from the last diagram leaks into the next.
 */
export default function DiagramEditorDialog(props: DiagramEditorDialogProps) {
  if (!props.start) return null;
  return <DiagramEditorSession {...props} start={props.start} />;
}

function DiagramEditorSession({
  start,
  userId,
  deckId,
  deckName,
  topics,
  onTopicsChange,
  onClose,
  onSaved,
  onDeleted,
}: DiagramEditorDialogProps & { start: DiagramEditorStart }) {
  const editing = start.kind === "edit" ? start.card : null;
  const editor = useDiagramEditor({
    userId,
    deckId,
    editing,
    picture: start.kind === "new" ? start.picture : null,
  });
  const [step, setStep] = useState<Step>(
    editing
      ? "label"
      : start.kind === "new" && start.picture
        ? start.next === "crop"
          ? "crop"
          : "kind"
        : "picture"
  );
  const [crop, setCrop] = useState<OcclusionCrop>(FULL_CROP);
  const [cropping, setCropping] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState<"discard" | "delete" | null>(null);
  const pictureUrl = useDiagramPictureUrl(editor.picture);
  const busy = editor.saving || editor.deleting || cropping;
  const aiEnabled = featureFlags.enableFlashcardAi;
  /** Where a picture leads: the one question about it, unless the diagram already has boxes. */
  const afterPicture = (): Step => (editing || editor.labels.length > 0 ? "label" : "kind");

  /*
   * The one decision a diagram needs. Labels printed on the picture are
   * covered -- by Jami on this tap, or by the student, who may want to leave
   * some showing -- and a picture without them is boxed and named by hand.
   */
  const chooseKind = (mode: "cover" | "name", options: { findLabels?: boolean } = {}) => {
    editor.setLabelMode(mode);
    editor.setTool("rect");
    setStep("label");
    if (mode === "cover" && options.findLabels && aiEnabled) void editor.detectLabels();
  };

  const close = () => {
    editor.releasePicture();
    onClose();
  };

  const requestClose = () => {
    if (busy) return;
    if (editor.dirty) setConfirming("discard");
    else close();
  };

  const save = async () => {
    const result = await editor.save();
    if (!result) return;
    editor.releasePicture();
    onSaved(result, { sourcePicture: editor.sourcePicture });
  };

  const remove = async () => {
    const removed = await editor.remove();
    setConfirming(null);
    if (!removed) return;
    editor.releasePicture();
    onDeleted?.(removed);
  };

  const applyCrop = async () => {
    const picture = editor.picture;
    if (picture?.kind === "new" && !isFullCrop(crop)) {
      setCropping(true);
      try {
        const cropped = await cropDiagramPicture(picture, crop);
        editor.applyCrop(cropped, crop);
      } catch (cropError) {
        console.error("Failed to crop a diagram picture.", cropError);
        editor.setError("That crop could not be made. Try again, or use the whole picture.");
        setCropping(false);
        return;
      }
      setCropping(false);
    }
    setCrop(FULL_CROP);
    setStep(afterPicture());
  };

  const takePicture = (picture: DiagramPicture, next: "label" | "crop") => {
    editor.setPicture(picture, { asSource: true });
    setCrop(FULL_CROP);
    setStep(next === "crop" ? "crop" : afterPicture());
  };

  /*
   * The keyboard, for the picture: never while typing a label.
   *
   * Listened for on the window in the capture phase, so Escape can let go of
   * a selected box before the dialog hears it and closes -- a second Escape
   * then closes as usual.
   */
  const editorRef = useRef<DiagramEditorController>(editor);
  useEffect(() => {
    editorRef.current = editor;
  });
  useEffect(() => {
    if (step !== "label" || confirming || previewing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTextField(event.target) || event.altKey) return;
      const current = editorRef.current;
      const key = event.key.toLowerCase();
      if (event.key === "Escape" && (current.selection || current.addingToLabelId)) {
        event.preventDefault();
        current.cancelAddingBox();
        current.setSelection(null);
        return;
      }
      if (current.selection && !event.ctrlKey && !event.metaKey) {
        const step = event.shiftKey ? 0.02 : 0.004;
        const nudges: Record<string, [number, number]> = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, -step],
          ArrowDown: [0, step],
        };
        if (nudges[event.key]) {
          event.preventDefault();
          current.nudgeSelected(...nudges[event.key]);
          return;
        }
        if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          current.removeSelectedShape();
          return;
        }
      }
      if (event.ctrlKey || event.metaKey) {
        if (key === "z") {
          event.preventDefault();
          if (event.shiftKey) current.redo();
          else current.undo();
        } else if (key === "y") {
          event.preventDefault();
          current.redo();
        }
        return;
      }
      const actions: Record<string, () => void> = {
        b: () => current.setTool("rect"),
        o: () => current.setTool("ellipse"),
        f: () => current.setTool("outline"),
        // A line from a name to its part is for pictures without printed labels.
        ...(current.labelMode === "name" ? { l: () => current.setTool("pointer") } : {}),
        "+": () => current.setZoom(current.zoom + 0.5),
        "=": () => current.setZoom(current.zoom + 0.5),
        "-": () => current.setZoom(current.zoom - 0.5),
        "0": () => current.setZoom(1),
      };
      const action = actions[key];
      if (action) {
        event.preventDefault();
        action();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [confirming, previewing, step]);

  const labelCount = editor.labels.length;
  const stepHint =
    step === "picture"
      ? "Add a picture"
      : step === "crop"
        ? "Crop to the diagram"
        : step === "kind"
          ? "One question"
          : editor.labelMode === "name"
          ? "Name the parts"
          : "Cover the labels";

  return (
    <Dialog
      open
      closeOnBackdrop={false}
      closeOnEscape={!busy && !confirming}
      className="fixed inset-0 flex sm:p-3 lg:p-5"
      onDismiss={requestClose}
    >
      <DialogBackdrop className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <DialogPanel className="relative m-auto flex h-full w-full flex-col overflow-hidden bg-[var(--color-surface-panel-strong)] shadow-e3 sm:max-w-[88rem] sm:rounded-2xl sm:border sm:border-[var(--color-border)]">
        <header className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2.5 sm:px-5">
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={requestClose}>
            Cancel
          </Button>
          <div className="min-w-0 flex-1 text-center">
            <DialogTitle className="truncate text-sm font-semibold text-text-primary sm:text-base">
              {editing ? "Edit diagram" : "New diagram"}
            </DialogTitle>
            <DialogDescription className="truncate text-xs text-text-muted">
              {deckName} · {stepHint}
            </DialogDescription>
          </div>
          {step === "label" ? (
            <Button type="button" size="sm" disabled={busy || !editor.picture} onClick={() => void save()}>
              {editor.saving ? "Saving…" : labelCount === 0 ? "Save" : "Save card"}
            </Button>
          ) : (
            <span aria-hidden="true" className="w-16" />
          )}
        </header>

        {step === "picture" ? (
          <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto p-4 sm:p-8">
            <div className="w-full max-w-xl space-y-5">
              <DiagramPictureSource userId={userId} disabled={busy} onPicture={takePicture} />
              {editor.picture ? (
                <div className="text-center">
                  <Button type="button" variant="ghost" onClick={() => setStep(afterPicture())}>
                    Keep the current picture
                  </Button>
                </div>
              ) : (
                <DiagramSteps />
              )}
            </div>
          </div>
        ) : null}

        {step === "crop" && editor.picture ? (
          <>
            <div className="min-h-0 flex-1 bg-[var(--color-glass-subtle)]">
              <DiagramCropStage
                imageUrl={pictureUrl.url}
                width={editor.picture.width}
                height={editor.picture.height}
                crop={crop}
                onChange={setCrop}
              />
            </div>
            <footer className="flex flex-col gap-3 border-t border-[var(--color-border)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <p className="text-sm text-text-secondary">
                Drag across the diagram to frame it, then adjust the corners. Everything outside is left out.
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={cropping}
                  onClick={() => {
                    setCrop(FULL_CROP);
                    setStep(afterPicture());
                  }}
                  className="flex-1 sm:flex-none"
                >
                  Use whole picture
                </Button>
                <Button type="button" disabled={cropping} onClick={() => void applyCrop()} className="flex-1 sm:flex-none">
                  {cropping ? "Cropping…" : "Crop"}
                </Button>
              </div>
            </footer>
          </>
        ) : null}

        {step === "kind" && editor.picture ? (
          <DiagramKindStep
            imageUrl={pictureUrl.url}
            aiEnabled={aiEnabled}
            canCrop={editor.picture.kind === "new"}
            onChoose={chooseKind}
            onCrop={() => setStep("crop")}
            onReplace={() => setStep("picture")}
          />
        ) : null}

        {step === "label" && editor.picture ? (
          <>
            <DiagramToolbar
              editor={editor}
              previewing={previewing}
              onTogglePreview={() => setPreviewing((current) => !current)}
              onCrop={() => {
                setPreviewing(false);
                setStep("crop");
              }}
            />
            {/* The diagram's colour reaches the editor's boxes and the label list's numbers. */}
            <div className={`flex min-h-0 flex-1 flex-col lg:flex-row ${occlusionCoverClass(editor.coverColor)}`}>
              <div className="relative h-[46dvh] shrink-0 bg-[var(--color-glass-subtle)] sm:h-[54dvh] lg:h-auto lg:min-w-0 lg:flex-1">
                {previewing ? (
                  <DiagramPreview editor={editor} imageUrl={pictureUrl.url} header={editor.header} />
                ) : (
                  <>
                    <DiagramCanvas
                      imageUrl={pictureUrl.url}
                      width={editor.picture.width}
                      height={editor.picture.height}
                      labels={editor.labels}
                      labelMode={editor.labelMode}
                      tool={editor.tool}
                      zoom={editor.zoom}
                      selection={editor.selection}
                      onSelect={editor.setSelection}
                      onDrawShape={(shape, pointerType) => {
                        // Naming a part means typing its name next, so its field is focused before
                        // the first key. Covering, a finger or pen usually draws the next box instead.
                        if (pointerType !== "mouse" && editor.labelMode !== "name") {
                          editor.drawShape(shape);
                          return;
                        }
                        let labelId: string | null = null;
                        flushSync(() => {
                          labelId = editor.drawShape(shape);
                        });
                        if (labelId) document.getElementById(diagramLabelFieldId(labelId))?.focus();
                      }}
                      onChangeShape={editor.changeShape}
                      onSetPointer={editor.setPointer}
                      pointerEnd={editor.pointerEnd}
                    />
                    {editor.tool === "pointer" ? (
                      <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center px-3">
                        <p role="status" className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface-panel-strong)] px-4 py-1.5 text-center text-sm text-text-primary shadow-card">
                          {editor.selection
                            ? `Tap the part label ${
                                editor.labels.findIndex((label) => label.id === editor.selection?.labelId) + 1
                              } names, or drag its line there`
                            : editor.labels.length > 0
                              ? "Drag from a name's box to the part it names"
                              : "Draw a box for the name first, then a line from it"}
                        </p>
                      </div>
                    ) : null}
                  </>
                )}
              </div>
              <aside className="min-h-0 flex-1 overflow-y-auto border-t border-[var(--color-border)] px-4 py-4 lg:w-[24rem] lg:flex-none lg:border-l lg:border-t-0 lg:px-5">
                {editor.error ? (
                  <p role="alert" className="app-danger mb-4 rounded-xl px-4 py-3 text-sm">
                    {editor.error}
                  </p>
                ) : null}
                <DiagramLabelPanel
                  editor={editor}
                  userId={userId}
                  topics={topics}
                  onTopicsChange={onTopicsChange}
                  aiEnabled={aiEnabled}
                />
                {editing ? (
                  <div className="mt-6 border-t border-[var(--color-border)] pt-4">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => setConfirming("delete")}
                      className="text-danger-text"
                    >
                      Delete diagram
                    </Button>
                  </div>
                ) : null}
              </aside>
            </div>
          </>
        ) : null}

        <ConfirmDialog
          open={confirming === "discard"}
          title={editing ? "Discard your changes?" : "Discard this diagram?"}
          description={
            editing
              ? "Your changes to this diagram have not been saved."
              : "The picture and boxes have not been saved yet."
          }
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          onClose={() => setConfirming(null)}
          onConfirm={() => {
            setConfirming(null);
            close();
          }}
        />
        <ConfirmDialog
          open={confirming === "delete"}
          title="Delete this diagram?"
          description={
            editing?.occlusion && getDiagramTargets(editing.occlusion.diagram).length > 1
              ? `This deletes all ${getDiagramTargets(editing.occlusion.diagram).length} of its cards and their review history. This cannot be undone.`
              : "This deletes the diagram and its review history. This cannot be undone."
          }
          confirmLabel="Delete diagram"
          busy={editor.deleting}
          onClose={() => setConfirming(null)}
          onConfirm={() => void remove()}
        />
      </DialogPanel>
    </Dialog>
  );
}

/** Three steps, said once, where a first-time student decides whether this is worth doing. */
function DiagramSteps() {
  const steps = [
    ["Add a picture", "A diagram, a slide, or a photo of a textbook page."],
    ["Cover the labels", "Cover printed labels yourself or with Jami, or box and name the parts."],
    ["Study it as one card", "Every label covered; uncover each to check, then reveal them all."],
  ];
  return (
    <ol aria-label="How diagram cards work" className="grid gap-2 sm:grid-cols-3">
      {steps.map(([title, detail], index) => (
        <li
          key={title}
          className="flex items-start gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-glass-subtle)] p-3 sm:block"
        >
          <span className="occlusion-edit-badge grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold sm:mb-2">
            {index + 1}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-text-primary">{title}</p>
            <p className="mt-0.5 text-xs leading-5 text-text-muted">{detail}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

type KindChoice = {
  key: string;
  title: string;
  detail: string;
  icon: ReactNode;
  badge?: string;
  onChoose: () => void;
};

function BoxAndNameIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-6 w-6">
      <rect x="3.5" y="5" width="9" height="7" rx="1.5" />
      <path d="M15 8.5h5.5M15 15.5h5.5M3.5 15.5h8" />
    </svg>
  );
}

function CoverByHandIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-6 w-6">
      <rect x="3.5" y="4.5" width="10" height="5" rx="1.2" fill="currentColor" fillOpacity="0.25" />
      <path d="M3.5 14.5h7M3.5 18.5h4.5" />
      <path d="m15.5 12.5 5 5-2 2-5-5z" />
    </svg>
  );
}

/**
 * The one question a picture is asked, before any drawing: are its labels
 * printed on it? That decides everything after -- covering what is there, or
 * boxing and naming the parts -- so it is asked once, big, with the picture in
 * view, instead of as a setting a student has to find.
 *
 * A picture with labels is then asked who covers them. Jami covers every one,
 * which is quickest; covering by hand lets a student choose which to hide and
 * leave the rest showing. Nothing is sent to Jami until it is chosen.
 */
function DiagramKindStep({
  imageUrl,
  aiEnabled,
  canCrop,
  onChoose,
  onCrop,
  onReplace,
}: {
  imageUrl: string | null;
  aiEnabled: boolean;
  canCrop: boolean;
  onChoose: (mode: "cover" | "name", options?: { findLabels?: boolean }) => void;
  onCrop: () => void;
  onReplace: () => void;
}) {
  const [askingWho, setAskingWho] = useState(false);
  const choices: KindChoice[] = askingWho
    ? [
        {
          key: "jami",
          title: "Jami covers them",
          detail: "Every printed label is covered for you. You just check the boxes.",
          icon: <JamiTutorIcon className="h-6 w-6" />,
          badge: "Fastest",
          onChoose: () => onChoose("cover", { findLabels: true }),
        },
        {
          key: "self",
          title: "I'll cover them myself",
          detail: "Draw a box over each label you want to learn. Leave any you want showing.",
          icon: <CoverByHandIcon />,
          onChoose: () => onChoose("cover"),
        },
      ]
    : [
        {
          key: "cover",
          title: "It has labels",
          detail: aiEnabled
            ? "Cover the printed labels, with Jami or by hand."
            : "Draw a box over each label. One tap drops a box.",
          icon: aiEnabled ? <JamiTutorIcon className="h-6 w-6" /> : <CoverByHandIcon />,
          onChoose: () => (aiEnabled ? setAskingWho(true) : onChoose("cover")),
        },
        {
          key: "name",
          title: "It has no labels",
          detail: "Box each part and type its name, or put the name beside it and draw a line to the part.",
          icon: <BoxAndNameIcon />,
          onChoose: () => onChoose("name"),
        },
      ];
  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <div className="relative min-h-[34dvh] flex-1 bg-[var(--color-glass-subtle)] p-4 sm:p-6">
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- a local preview or a signed URL, shown as it is
          <img src={imageUrl} alt="The diagram" className="absolute inset-0 m-auto max-h-[calc(100%-2rem)] max-w-[calc(100%-2rem)] rounded-xl object-contain shadow-card sm:max-h-[calc(100%-3rem)] sm:max-w-[calc(100%-3rem)]" />
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col justify-center gap-3 border-t border-[var(--color-border)] p-4 sm:p-6 lg:w-[26rem] lg:border-l lg:border-t-0">
        <h3 className="text-lg font-semibold text-text-primary">
          {askingWho ? "Who covers the labels?" : "Are the labels written on the picture?"}
        </h3>
        {choices.map((choice) => (
          <button
            key={choice.key}
            type="button"
            onClick={choice.onChoose}
            className="group flex w-full items-start gap-3.5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-glass-subtle)] p-4 text-left transition duration-fast hover:border-accent hover:bg-[var(--color-glass-medium)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-selected-border)]"
          >
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[var(--color-glass-medium)] text-accent transition group-hover:scale-105">
              {choice.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="text-base font-semibold text-text-primary">{choice.title}</span>
                {choice.badge ? (
                  <span className="rounded-full bg-[var(--color-glass-medium)] px-2 py-0.5 text-2xs font-semibold text-accent">
                    {choice.badge}
                  </span>
                ) : null}
              </span>
              <span className="mt-1 block text-sm leading-5 text-text-secondary">{choice.detail}</span>
            </span>
            <span aria-hidden="true" className="self-center text-lg text-text-muted transition group-hover:translate-x-0.5 group-hover:text-text-primary">
              ›
            </span>
          </button>
        ))}
        <div className="flex flex-wrap justify-center gap-1 pt-1">
          {askingWho ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => setAskingWho(false)}>
              Back
            </Button>
          ) : (
            <>
              {canCrop ? (
                <Button type="button" size="sm" variant="ghost" onClick={onCrop}>
                  Crop first
                </Button>
              ) : null}
              <Button type="button" size="sm" variant="ghost" onClick={onReplace}>
                Use another picture
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ToolbarDivider() {
  return <span aria-hidden="true" className="mx-1 h-6 w-px shrink-0 bg-[var(--color-border)]" />;
}

function DiagramToolbar({
  editor,
  previewing,
  onTogglePreview,
  onCrop,
}: {
  editor: DiagramEditorController;
  previewing: boolean;
  onTogglePreview: () => void;
  onCrop: () => void;
}) {
  const disabled = editor.saving || editor.deleting;
  const drawingDisabled = disabled || previewing;
  return (
    <div
      role="toolbar"
      aria-label="Diagram tools"
      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-[var(--color-border)] px-3 py-2 sm:px-5"
    >
      <div className="flex items-center gap-1.5">
      <ToolbarIconButton
        label="Box (B)"
        icon="box"
        active={editor.tool === "rect"}
        pressed={editor.tool === "rect"}
        disabled={drawingDisabled}
        onClick={() => editor.setTool("rect")}
      />
      <ToolbarIconButton
        label="Oval (O)"
        icon="oval"
        active={editor.tool === "ellipse"}
        pressed={editor.tool === "ellipse"}
        disabled={drawingDisabled}
        onClick={() => editor.setTool("ellipse")}
      />
      <ToolbarIconButton
        label="Trace an outline (F)"
        icon="lasso"
        active={editor.tool === "outline"}
        pressed={editor.tool === "outline"}
        disabled={drawingDisabled}
        onClick={() => editor.setTool("outline")}
      />
      {editor.labelMode === "name" ? (
        <ToolbarIconButton
          label="Line to the part (L)"
          icon="pointer"
          active={editor.tool === "pointer"}
          pressed={editor.tool === "pointer"}
          disabled={drawingDisabled}
          onClick={() => editor.setTool("pointer")}
        />
      ) : null}
      <ToolbarDivider />
      <ToolbarIconButton label="Undo" icon="undo" disabled={drawingDisabled || !editor.canUndo} onClick={editor.undo} />
      <ToolbarIconButton label="Redo" icon="redo" disabled={drawingDisabled || !editor.canRedo} onClick={editor.redo} />
      <ToolbarIconButton
        label="Remove selected box"
        icon="trash"
        disabled={drawingDisabled || !editor.selection}
        onClick={editor.removeSelectedShape}
      />
      </div>
      <div className="flex items-center gap-1.5">
      <DiagramCoverColorMenu value={editor.coverColor} onChange={editor.setCoverColor} disabled={disabled} />
      <ToolbarDivider />
      <ToolbarIconButton
        label="Zoom out"
        icon="zoom-out"
        disabled={drawingDisabled || editor.zoom <= 1}
        onClick={() => editor.setZoom(editor.zoom - 0.5)}
      />
      <span className="w-11 shrink-0 text-center text-xs font-medium tabular-nums text-text-muted" aria-live="polite">
        {Math.round(editor.zoom * 100)}%
      </span>
      <ToolbarIconButton
        label="Zoom in"
        icon="zoom-in"
        disabled={drawingDisabled || editor.zoom >= 4}
        onClick={() => editor.setZoom(editor.zoom + 0.5)}
      />
      <ToolbarDivider />
      {editor.picture?.kind === "new" ? (
        <ToolbarIconButton label="Crop the picture" icon="crop" disabled={disabled} onClick={onCrop} />
      ) : null}
      <ToolbarIconButton
        label={previewing ? "Back to editing" : "Preview as a card"}
        icon="eye"
        active={previewing}
        pressed={previewing}
        disabled={disabled || editor.labels.length === 0}
        onClick={onTogglePreview}
      />
      </div>
    </div>
  );
}

/**
 * The diagram as a card will ask it, before saving: one label covered, then
 * uncovered, with the diagram's own settings for the rest.
 */
function DiagramPreview({
  editor,
  imageUrl,
  header,
}: {
  editor: DiagramEditorController;
  imageUrl: string | null;
  header: string;
}) {
  const picture = editor.picture;
  const diagram: OcclusionDiagram | null = picture
    ? {
        id: "preview",
        image: { storagePath: "", width: picture.width, height: picture.height },
        labelMode: editor.labelMode,
        hideOthers: editor.hideOthers,
        labels: editor.labels,
        groups: groupsForCardStyle({
          labels: editor.labels,
          groups: editor.groups.filter((group) => group.labelIds.length >= 2),
          cardStyle: editor.cardStyle,
        }),
        cardStyle: editor.cardStyle,
        ...(editor.pointerEnd === "arrow" ? { pointerEnd: "arrow" as const } : {}),
        ...(editor.coverColor ? { coverColor: editor.coverColor } : {}),
      }
    : null;
  // Every card the diagram will make: the one whole-diagram card, or each label then each group.
  const cards: CardOcclusion[] = diagram
    ? getDiagramTargets(diagram).map((target) =>
        "groupId" in target ? { diagram, groupId: target.groupId } : { diagram, labelId: target.labelId }
      )
    : [];
  const [position, setPosition] = useState(() =>
    Math.max(0, editor.labels.findIndex((label) => label.id === editor.selection?.labelId))
  );
  const [revealed, setRevealed] = useState(false);
  const index = Math.min(position, cards.length - 1);
  const occlusion = cards[index];
  if (!diagram || !occlusion) return null;

  const { group } = getOcclusionTargets(occlusion);
  const words = getRevealedAnswerWords(occlusion);
  const answer = words.length > 0 ? words.join("; ") : group ? "The labels on the picture" : "The label on the picture";
  const go = (step: number) => {
    setPosition((index + step + cards.length) % cards.length);
    setRevealed(false);
  };

  return (
    <div className="flex h-full flex-col gap-3 p-3 sm:p-5">
      <div className="min-h-0 flex-1">
        <OcclusionPicture
          diagram={diagram}
          masks={getOcclusionMasks(occlusion, revealed ? "answer" : "question")}
          label={`Preview of card ${index + 1}`}
          imageUrl={imageUrl}
          fit="contain"
          className="shadow-card"
        />
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-center gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={() => go(-1)} aria-label="Previous card">
          ‹
        </Button>
        <div className="min-w-0 text-center">
          <p className="text-xs text-text-muted">
            Card {index + 1} of {cards.length}
            {group ? " · asked together" : ""}
          </p>
          <StudyText
            as="p"
            text={revealed ? answer : getOcclusionPrompt(occlusion, header)}
            className="text-sm font-medium text-text-primary"
          />
        </div>
        <Button type="button" size="sm" variant="ghost" onClick={() => go(1)} aria-label="Next card">
          ›
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={() => setRevealed((current) => !current)}>
          {revealed ? "Cover again" : "Reveal"}
        </Button>
      </div>
    </div>
  );
}
