"use client";

import { useState } from "react";
import ExamCourseFields from "@/components/practice/ExamCourseFields";
import { Button, Card, FeedbackBanner } from "@/components/ui";
import { useExamCourseOptions } from "@/hooks/useExamCourseOptions";
import {
  EMPTY_EXAM_COURSE_DRAFT,
  resolveExamCourseDraft,
  type ExamCourseDraft,
} from "@/lib/practice/exam-course-form";
import type { StudyFolder } from "@/lib/workspace/study-folders";
import { updateStudyFolder } from "@/services/study/folders";

/**
 * The one thing a folder needs before it can practise: which course this is.
 *
 * Asked once, here, rather than at the start of every session -- a real
 * question only means anything against a specification, and getting the wrong
 * one is worse than getting none. New folders can answer it as they are
 * created; this is for the folders that were made before they could.
 *
 * The questions themselves live in `ExamCourseFields`, shared with creating and
 * editing a folder, so the course is asked the same way everywhere.
 */
export default function ExamCourseSetup({
  userId,
  folder,
  onSaved,
}: {
  userId: string;
  folder: StudyFolder;
  onSaved(folder: StudyFolder): void;
}) {
  const [draft, setDraft] = useState<ExamCourseDraft>(EMPTY_EXAM_COURSE_DRAFT);
  const options = useExamCourseOptions(draft.board);
  const resolved = resolveExamCourseDraft(draft, options.courses);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    const examCourse = resolved.course;
    if (!examCourse) return;
    setSaving(true);
    setError("");
    try {
      await updateStudyFolder(userId, folder.id, { examCourse });
      onSaved({ ...folder, examCourse, updatedAt: Date.now() });
    } catch {
      setError("Your course could not be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card tone="warm" padding="md">
      {error ? (
        <div className="mb-4">
          <FeedbackBanner type="error" message={error} onDismiss={() => setError("")} />
        </div>
      ) : null}
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-text-secondary">
        Set up once
      </p>
      <h3 className="mt-2 text-lg font-semibold text-text-primary">
        What are you studying in {folder.name}?
      </h3>
      <p className="mt-1 max-w-lg text-sm leading-5 text-text-muted">
        We only show questions from your own course, so we ask once and remember it.
      </p>

      <div className="mt-5 max-w-2xl">
        <ExamCourseFields
          value={draft}
          onChange={setDraft}
          options={options}
          studyLevel={folder.studyLevel}
          subjectHint={`${folder.name} ${folder.subject ?? ""}`}
          disabled={saving}
        />
      </div>

      <div className="mt-5 flex justify-end">
        <Button disabled={!resolved.course || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save and start practicing"}
        </Button>
      </div>
    </Card>
  );
}
