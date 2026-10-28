"use client";

import { useCallback, useMemo, useState } from "react";
import AppPage from "@/components/layout/AppPage";
import {
  Button,
  ButtonLink,
  ConfirmDialog,
  EmptyState,
  FeedbackBanner,
  SectionHeader,
  Skeleton,
} from "@/components/ui";
import { useFeedback } from "@/hooks/useFeedback";
import { useUser } from "@/components/providers/UserProvider";
import type { Topic } from "@/lib/material/topics";
import type { Notebook } from "@/lib/workspace/notebooks";
import type { StudyFolder } from "@/lib/workspace/study-folders";
import {
  getActiveStudyFoldersPage,
  type StudyFolderPageCursor,
} from "@/services/study/folders";
import {
  getRecentActiveNotebooks,
  updateNotebook,
} from "@/services/study/notebooks";
import { getActiveTopics } from "@/services/study/topics";
import { deletePracticePaper } from "@/services/study/practice-papers";
import { useDashboardData } from "@/hooks/useDashboardData";
import CreateFolderDialog from "./CreateFolderDialog";
import FolderObjectCard, { FolderArt } from "./FolderObjectCard";
import NotebookEditorDialog from "./NotebookEditorDialog";
import { NotebookArt, NotebookObjectCard } from "./NotebookObjectCard";
import PastPaperPracticeSection from "@/components/practice/PastPaperPracticeSection";
import PracticePaperProgress from "@/components/practice/PracticePaperProgress";
import ReadyToPractise from "@/components/practice/ReadyToPractise";
import { featureFlags } from "@/lib/app/feature-flags";

function notebookTypeLabel(type: Notebook["type"]) {
  if (type === "uploaded_file") return "Uploaded file notebook";
  if (type === "ai_questions") return "AI questions notebook";
  if (type === "general_working" || type === "free_working") return "Working notebook";
  if (type === "source_notes") return "Source notes";
  if (type === "past_paper") return "Paper notebook";
  if (type === "practice_paper") return "Practice paper";
  if (type === "practice") return "Practice notebook";
  return "Blank notebook";
}

function formatDate(value: number) {
  if (!value) return "Not opened yet";
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export default function PracticeWorkspace() {
  const { user } = useUser();
  const [folders, setFolders] = useState<StudyFolder[]>([]);
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [topicsLoaded, setTopicsLoaded] = useState(false);
  const [notebooksUnavailable, setNotebooksUnavailable] = useState(false);
  const [folderCursor, setFolderCursor] =
    useState<StudyFolderPageCursor | null>(null);
  const [loadingMoreFolders, setLoadingMoreFolders] = useState(false);
  const [editingNotebook, setEditingNotebook] = useState<Notebook | null>(null);
  const [notebookPendingDelete, setNotebookPendingDelete] =
    useState<Notebook | null>(null);
  const [deletingNotebookId, setDeletingNotebookId] = useState<string | null>(
    null
  );
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const {
    feedback,
    success,
    showError,
    showThrownError,
    clear: clearFeedback,
  } = useFeedback();

  const loadWorkspace = useCallback(async () => {
    const [foldersResult, notebooksResult] = await Promise.allSettled([
      getActiveStudyFoldersPage(user.uid),
      getRecentActiveNotebooks(user.uid, 3),
    ]);
    if (foldersResult.status === "rejected") throw foldersResult.reason;

    return {
      folders: foldersResult.value.items,
      folderCursor: foldersResult.value.nextCursor,
      notebooks:
        notebooksResult.status === "fulfilled" ? notebooksResult.value : null,
      failures: [
        ["notebooks", notebooksResult] as const,
      ].filter(([, result]) => result.status === "rejected"),
    };
  }, [user.uid]);

  const applyWorkspace = useCallback(
    (data: Awaited<ReturnType<typeof loadWorkspace>>) => {
      setFolders(data.folders);
      setFolderCursor(data.folderCursor);
      setNotebooksUnavailable(data.notebooks === null);
      if (data.notebooks !== null) setNotebooks(data.notebooks);
      if (data.failures.length > 0) {
        console.warn("Some Practice workspace sections failed to load.", {
          sections: data.failures.map(([section]) => section),
          errors: data.failures.map(([, result]) =>
            result.status === "rejected" ? result.reason : undefined
          ),
        });
        showError("Recent notebooks could not load. Your folders are still available.");
      }
    },
    [showError]
  );

  const handleWorkspaceLoadError = useCallback((error: unknown) => {
    console.error("Failed to load the Practice workspace.", error);
    showError("Failed to load your folders and notebooks.");
  }, [showError]);

  const handleWorkspaceLoadStart = useCallback(() => {
    clearFeedback();
  }, [clearFeedback]);

  const { loading } = useDashboardData({
    requestKey: user.uid,
    load: loadWorkspace,
    apply: applyWorkspace,
    onError: handleWorkspaceLoadError,
    onLoadStart: handleWorkspaceLoadStart,
  });

  const recentNotebooks = useMemo(
    () =>
      [...notebooks]
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, 3),
    [notebooks]
  );

  const handleEditNotebook = async (notebook: Notebook) => {
    if (topicsLoaded) {
      setEditingNotebook(notebook);
      return;
    }
    clearFeedback();
    try {
      const nextTopics = await getActiveTopics(user.uid);
      setTopics(nextTopics);
      setTopicsLoaded(true);
      setEditingNotebook(notebook);
    } catch (error) {
      console.error("Failed to load Topics for notebook editing.", error);
      showError("Topics are unavailable. Refresh before editing this notebook.");
    }
  };

  const handleLoadMoreFolders = async () => {
    if (!folderCursor || loadingMoreFolders) return;
    setLoadingMoreFolders(true);
    try {
      const nextPage = await getActiveStudyFoldersPage(user.uid, {
        cursor: folderCursor,
      });
      setFolders((current) => {
        const merged = new Map(current.map((folder) => [folder.id, folder]));
        nextPage.items.forEach((folder) => merged.set(folder.id, folder));
        return Array.from(merged.values());
      });
      setFolderCursor(nextPage.nextCursor);
    } catch (error) {
      console.error("Failed to load more Practice folders.", error);
      showError("Could not load more folders. Try again in a moment.");
    } finally {
      setLoadingMoreFolders(false);
    }
  };

  const firstFolderHref = folders[0]
    ? `/dashboard/folders/${encodeURIComponent(folders[0].id)}`
    : null;

  const handleDeleteNotebook = async () => {
    if (!notebookPendingDelete) return;
    const notebook = notebookPendingDelete;
    setDeletingNotebookId(notebook.id);
    clearFeedback();
    try {
      if (notebook.type === "practice_paper") {
        await deletePracticePaper(user.uid, notebook.pastPaperId ?? notebook.id);
      } else {
        await updateNotebook(user.uid, notebook.id, { archived: true });
      }
      setNotebooks((current) =>
        current.filter((item) => item.id !== notebook.id)
      );
      setNotebookPendingDelete(null);
      success(`${notebook.title} deleted.`);
    } catch (error) {
      showThrownError(error, "Could not delete notebook.");
    } finally {
      setDeletingNotebookId(null);
    }
  };

  return (
    <AppPage
      title="Folders"
      backHref="/dashboard"
      backLabel="Today"
      width="3xl"
      contentClassName="space-y-7 sm:space-y-9"
    >
      <CreateFolderDialog
        open={createFolderOpen}
        userId={user.uid}
        onClose={() => setCreateFolderOpen(false)}
        onCreated={(folder) => {
          setFolders((current) => [
            folder,
            ...current.filter((item) => item.id !== folder.id),
          ]);
          success(`“${folder.name}” is ready. Open it to add a notebook.`);
        }}
      />

      <ConfirmDialog
        open={notebookPendingDelete !== null}
        title={`Delete ${notebookPendingDelete?.title ?? "this notebook"}?`}
        description={
          notebookPendingDelete?.type === "practice_paper"
            ? "This permanently deletes the paper, its attempts, saved pages, marking data, and attached files. This cannot be undone."
            : "This removes the notebook from your workspace. Its saved pages are retained so it can be recovered later."
        }
        confirmLabel={
          notebookPendingDelete?.type === "practice_paper"
            ? "Delete paper permanently"
            : "Delete notebook"
        }
        busy={
          notebookPendingDelete !== null &&
          deletingNotebookId === notebookPendingDelete.id
        }
        onConfirm={() => void handleDeleteNotebook()}
        onClose={() => setNotebookPendingDelete(null)}
      />

      {editingNotebook ? (
        <NotebookEditorDialog
          userId={user.uid}
          notebook={editingNotebook}
          topics={topics}
          onTopicsChange={setTopics}
          onClose={() => setEditingNotebook(null)}
          onSaved={(updatedNotebook) => {
            setNotebooks((current) =>
              current.map((item) =>
                item.id === updatedNotebook.id ? updatedNotebook : item
              )
            );
            setEditingNotebook(null);
            success("Notebook updated.");
          }}
          onArchived={(notebookId) => {
            const archivedTitle = editingNotebook.title;
            setNotebooks((current) =>
              current.filter((item) => item.id !== notebookId)
            );
            setEditingNotebook(null);
            success(`${archivedTitle} archived.`);
          }}
        />
      ) : null}

      {feedback ? (
        <FeedbackBanner
          type={feedback.type}
          message={feedback.message}
          onDismiss={() => clearFeedback()}
        />
      ) : null}

      {loading ? (
        <div className="space-y-7 sm:space-y-9" aria-label="Loading folders and notebooks">
          <section className="space-y-4">
            <Skeleton className="h-7 w-48 rounded-full" />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {Array.from({ length: 3 }).map((_, index) => (
                <Skeleton key={index} className="h-40 rounded-xl" />
              ))}
            </div>
          </section>
          <section className="space-y-4">
            <Skeleton className="h-7 w-36 rounded-full" />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
              {Array.from({ length: 5 }).map((_, index) => (
                <Skeleton key={index} className="h-36 rounded-xl" />
              ))}
            </div>
          </section>
        </div>
      ) : (
        <>
          <PastPaperPracticeSection
            pastPapersEnabled={featureFlags.enablePastPaperPractice}
          />
          {featureFlags.enablePastPaperPractice ? <ReadyToPractise userId={user.uid} /> : null}
          <PracticePaperProgress userId={user.uid} />
          <section className="space-y-4">
            <SectionHeader eyebrow="Continue working" title="Recent notebooks" />
            {notebooksUnavailable ? (
              <EmptyState
                emoji="Notebook"
                title="Recent notebooks are unavailable"
                description="Your folders are still here. Refresh to try loading notebooks again."
                variant="compact"
              />
            ) : recentNotebooks.length > 0 ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
                {recentNotebooks.map((notebook) => {
                  const folder = folders.find(
                    (item) => item.id === notebook.folderId
                  );
                  return (
                    <NotebookObjectCard
                      key={notebook.id}
                      href={`/dashboard/notebooks/${encodeURIComponent(notebook.id)}`}
                      title={notebook.title}
                      typeLabel={notebookTypeLabel(notebook.type)}
                      color={notebook.color}
                      icon={notebook.icon}
                      pageColor={notebook.pageColor}
                      updatedLabel={folder?.name ?? formatDate(notebook.updatedAt)}
                      onEdit={() => void handleEditNotebook(notebook)}
                      onDelete={() => setNotebookPendingDelete(notebook)}
                      deleting={deletingNotebookId === notebook.id}
                      compact
                    />
                  );
                })}
              </div>
            ) : (
              <EmptyState
                illustration={<NotebookArt pageStyle="lined" />}
                title="Create a folder, then open a notebook"
                description="Your subject folder is where notebooks and the rest of your study material live."
                variant="compact"
                action={
                  firstFolderHref ? (
                    <ButtonLink href={firstFolderHref}>Open a folder</ButtonLink>
                  ) : (
                    <Button
                      type="button"
                      onClick={() => setCreateFolderOpen(true)}
                    >
                      Create folder
                    </Button>
                  )
                }
              />
            )}
          </section>

          <section className="space-y-4">
            <SectionHeader
              eyebrow="Folders"
              title="Study spaces"
              description="Keep each subject’s notebooks, decks, and sources together."
              action={
                folders.length > 0 ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    data-tutorial-target="create-folder"
                    onClick={() => setCreateFolderOpen(true)}
                  >
                    New folder
                  </Button>
                ) : null
              }
            />
            {folders.length > 0 ? (
              <>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
                  {folders.map((folder, index) => (
                    <div key={folder.id} className="h-full" data-tutorial-target={index === 0 ? "first-folder" : undefined}>
                      <FolderObjectCard
                        href={`/dashboard/folders/${encodeURIComponent(folder.id)}`}
                        title={folder.name}
                        color={folder.color}
                        icon={folder.icon}
                      />
                    </div>
                  ))}
                </div>
                {folderCursor ? (
                  <div className="flex justify-center">
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={loadingMoreFolders}
                      aria-busy={loadingMoreFolders}
                      onClick={() => void handleLoadMoreFolders()}
                    >
                      {loadingMoreFolders ? "Loading..." : "Load more folders"}
                    </Button>
                  </div>
                ) : null}
              </>
            ) : (
              <EmptyState
                illustration={<FolderArt />}
                title="Create your first study space"
                description="Start with one broad subject."
                action={
                  <Button
                    type="button"
                    data-tutorial-target="create-folder"
                    onClick={() => setCreateFolderOpen(true)}
                  >
                    Create folder
                  </Button>
                }
              />
            )}
          </section>
        </>
      )}
    </AppPage>
  );
}
