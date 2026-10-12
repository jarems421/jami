"use client";

import Image from "next/image";
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { NotebookIcon } from "@/components/workspace/NotebookToolbarIconButton";
import {
  NOTEBOOK_PAGE_COORDINATE_HEIGHT,
  NOTEBOOK_PAGE_COORDINATE_WIDTH,
  type NotebookImageRef,
  type NotebookResizeHandle,
} from "@/lib/workspace/notebooks";
import { moveNotebookImageRef, resizeNotebookImageRef } from "@/lib/workspace/notebook-placement";
import NotebookResizeHandles from "@/components/workspace/NotebookResizeHandles";
import { getNotebookFileBytes } from "@/services/study/notebook-files";

/**
 * Screen pixels a pointer has to travel before a press counts as a drag.
 *
 * Without it every tap to select an image saved a move of a pixel or two, and
 * each of those writes was one more chance to race the page's autosave.
 */
const DRAG_THRESHOLD_PX = 3;

function placement(image: NotebookImageRef) {
  return {
    x: image.x ?? 0,
    y: image.y ?? 0,
    width: image.displayWidth ?? 480,
    height: image.displayHeight ?? 360,
  };
}

function styleFor(image: NotebookImageRef) {
  const placed = placement(image);
  return {
    left: `${(placed.x / NOTEBOOK_PAGE_COORDINATE_WIDTH) * 100}%`,
    top: `${(placed.y / NOTEBOOK_PAGE_COORDINATE_HEIGHT) * 100}%`,
    width: `${(placed.width / NOTEBOOK_PAGE_COORDINATE_WIDTH) * 100}%`,
    height: `${(placed.height / NOTEBOOK_PAGE_COORDINATE_HEIGHT) * 100}%`,
    ...(image.rotation ? { transform: `rotate(${image.rotation}rad)` } : {}),
  };
}

function NotebookPlacedImage({ image }: { image: NotebookImageRef }) {
  const [loadedUrl, setLoadedUrl] = useState("");
  const assetUrl = image.localPreviewUrl ?? loadedUrl;

  useEffect(() => {
    if (image.localPreviewUrl || !image.storagePath) return;
    let objectUrl = "";
    let cancelled = false;
    void getNotebookFileBytes(image.storagePath)
      .then((bytes) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(new Blob([bytes]));
        setLoadedUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [image.localPreviewUrl, image.storagePath]);

  return (
    <div
      className="pointer-events-none absolute z-10 overflow-hidden rounded-sm"
      style={styleFor(image)}
    >
      {assetUrl ? (
        <Image
          alt={image.altText || "Notebook image"}
          src={assetUrl}
          fill
          unoptimized
          sizes="48rem"
          className="object-contain"
        />
      ) : (
        <div
          aria-hidden="true"
          className="h-full w-full animate-pulse rounded-sm bg-[var(--color-glass-subtle)]"
        />
      )}
    </div>
  );
}

type Gesture = {
  kind: "move" | "resize";
  corner?: NotebookResizeHandle;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  /** The layer's size when the press began; zoom does not change mid-drag. */
  layerWidth: number;
  layerHeight: number;
  original: NotebookImageRef;
};

type Pending = Record<string, { commitId: number; image: NotebookImageRef }>;

type Props = {
  images: NotebookImageRef[];
  editingEnabled?: boolean;
  selectedImageId?: string | null;
  onSelect?: (imageId: string | null) => void;
  onCommit?: (images: NotebookImageRef[]) => void | Promise<void>;
  onDelete?: (imageId: string) => void;
};

function geometryFor(gesture: Gesture, clientX: number, clientY: number) {
  const deltaX =
    ((clientX - gesture.startClientX) / gesture.layerWidth) * NOTEBOOK_PAGE_COORDINATE_WIDTH;
  const deltaY =
    ((clientY - gesture.startClientY) / gesture.layerHeight) * NOTEBOOK_PAGE_COORDINATE_HEIGHT;
  return gesture.kind === "move"
    ? moveNotebookImageRef(gesture.original, deltaX, deltaY)
    : resizeNotebookImageRef(gesture.original, deltaX, deltaY, gesture.corner);
}

function NotebookImageLayer({
  images,
  editingEnabled = false,
  selectedImageId = null,
  onSelect,
  onCommit,
  onDelete,
}: Props) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  /*
   * The gesture and the latest pointer position live in refs, and the preview
   * is committed at most once a frame. Holding the gesture in state meant the
   * first moves after a press read the previous render's null gesture and were
   * dropped, and a render per raw pointer event -- several a frame with a
   * Pencil -- is what made a drag stutter behind the pointer.
   */
  const gestureRef = useRef<Gesture | null>(null);
  const pointRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const frameRef = useRef<number | null>(null);
  const [draft, setDraft] = useState<NotebookImageRef | null>(null);
  /*
   * Where each image was left, held until its save lands.
   *
   * The page's images keep their previous geometry until the write returns, so
   * dropping the preview at pointer-up snapped the image back for that window
   * and forward again after. Kept per image, so moving a second image while the
   * first is still saving does not put the first one back.
   */
  const [pending, setPending] = useState<Pending>({});
  const pendingRef = useRef<Pending>({});
  const imagesRef = useRef(images);
  const commitIdRef = useRef(0);

  useEffect(() => {
    imagesRef.current = images;
    pendingRef.current = pending;
  });

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    []
  );

  const displayedImages = images.map((image) => {
    if (draft?.id === image.id) return draft;
    return pending[image.id]?.image ?? image;
  });

  const commitImage = useCallback(
    (next: NotebookImageRef) => {
      const commitId = (commitIdRef.current += 1);
      const nextPending = { ...pendingRef.current, [next.id]: { commitId, image: next } };
      pendingRef.current = nextPending;
      setPending(nextPending);
      const list = imagesRef.current.map((image) => nextPending[image.id]?.image ?? image);
      void Promise.resolve(onCommit?.(list))
        .catch(() => undefined)
        .finally(() => {
          // A newer commit of this image owns the preview; leave it. A rejected
          // save clears too, so the image falls back to what is stored.
          setPending((current) => {
            if (current[next.id]?.commitId !== commitId) return current;
            const rest = { ...current };
            delete rest[next.id];
            return rest;
          });
        });
    },
    [onCommit]
  );

  const startGesture = useCallback(
    (
      image: NotebookImageRef,
      event: ReactPointerEvent<HTMLElement>,
      corner?: NotebookResizeHandle
    ) => {
      event.stopPropagation();
      const bounds = layerRef.current?.getBoundingClientRect();
      if (!bounds?.width || !bounds.height) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      pointRef.current = null;
      gestureRef.current = {
        kind: corner ? "resize" : "move",
        ...(corner ? { corner } : {}),
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        layerWidth: bounds.width,
        layerHeight: bounds.height,
        // The displayed image, so a drag that starts mid-save continues from
        // what the student can see rather than from the last stored geometry.
        original: image,
      };
    },
    []
  );

  const moveGesture = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    event.stopPropagation();
    pointRef.current = { clientX: event.clientX, clientY: event.clientY };
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const current = gestureRef.current;
      const point = pointRef.current;
      if (!current || !point) return;
      setDraft(geometryFor(current, point.clientX, point.clientY));
    });
  }, []);

  const finishGesture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      event.stopPropagation();
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      gestureRef.current = null;
      // A cancelled pointer reports no useful position, so the last one seen
      // stands in for it.
      const point =
        event.type === "pointercancel"
          ? pointRef.current
          : { clientX: event.clientX, clientY: event.clientY };
      pointRef.current = null;
      setDraft(null);
      if (!point) return;
      const travelled = Math.hypot(
        point.clientX - gesture.startClientX,
        point.clientY - gesture.startClientY
      );
      if (travelled < DRAG_THRESHOLD_PX) return;
      commitImage(geometryFor(gesture, point.clientX, point.clientY));
    },
    [commitImage]
  );

  const handleKeyDown = useCallback(
    (image: NotebookImageRef, event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if ((event.key === "Delete" || event.key === "Backspace") && onDelete) {
        event.preventDefault();
        onDelete(image.id);
        return;
      }
      const amount = event.shiftKey ? 24 : 8;
      const delta =
        event.key === "ArrowLeft"
          ? { x: -amount, y: 0 }
          : event.key === "ArrowRight"
            ? { x: amount, y: 0 }
            : event.key === "ArrowUp"
              ? { x: 0, y: -amount }
              : event.key === "ArrowDown"
                ? { x: 0, y: amount }
                : null;
      if (!delta) return;
      event.preventDefault();
      commitImage(moveNotebookImageRef(image, delta.x, delta.y));
    },
    [commitImage, onDelete]
  );

  return (
    <div ref={layerRef} className="pointer-events-none absolute inset-0">
      {displayedImages.map((image) => (
        <NotebookPlacedImage key={image.id} image={image} />
      ))}
      {editingEnabled ? (
        <div className="pointer-events-none absolute inset-0 z-[26]">
          {displayedImages.map((image) => {
            const selected = selectedImageId === image.id;
            const dragging = draft?.id === image.id;
            const name = image.altText || "notebook image";
            return (
              <div
                key={image.id}
                className="pointer-events-none absolute"
                style={styleFor(image)}
              >
                <button
                  type="button"
                  aria-label={`Move ${name}`}
                  aria-pressed={selected}
                  className={`pointer-events-auto absolute inset-0 touch-none rounded-sm border bg-transparent outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/55 ${
                    selected
                      ? "cursor-move border-accent shadow-ring"
                      : "cursor-pointer border-transparent hover:border-accent/55"
                  }`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect?.(image.id);
                  }}
                  onKeyDown={(event) => handleKeyDown(image, event)}
                  onPointerDown={(event) => {
                    onSelect?.(image.id);
                    startGesture(image, event);
                  }}
                  onPointerMove={moveGesture}
                  onPointerUp={finishGesture}
                  onPointerCancel={finishGesture}
                />
                {selected && onDelete && !dragging ? (
                  <button
                    type="button"
                    aria-label={`Delete ${name}`}
                    title="Delete image"
                    className="pointer-events-auto absolute left-1/2 top-2 z-20 inline-flex h-9 -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-panel)] pl-2.5 pr-3.5 text-xs font-semibold text-text-primary shadow-e1 outline-none transition-colors hover:border-[var(--color-error-mark)] focus-visible:ring-2 focus-visible:ring-accent/55"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      onDelete(image.id);
                    }}
                  >
                    <NotebookIcon name="trash" />
                    Delete
                  </button>
                ) : null}
                {selected ? (
                  <NotebookResizeHandles
                    name={name}
                    onStart={(handle, event) => startGesture(image, event, handle)}
                    onMove={moveGesture}
                    onEnd={finishGesture}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export default memo(NotebookImageLayer);
