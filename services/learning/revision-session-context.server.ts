import "server-only";

import { isAnyAiProviderConfigured } from "@/lib/ai/provider-router";
import { featureFlags } from "@/lib/app/feature-flags";
import { projectRevisionSession } from "@/lib/revision/view";
import type { RevisionSessionRecord, RevisionTarget } from "@/lib/revision/types";
import { mapStudyFolderData } from "@/lib/workspace/study-folders";
import type { RevisionConceptContext, RevisionMaterialPassage } from "@/services/ai/revision-session.server";
import { retrieveTutorEvidence } from "@/services/ai/source-index.server";
import { apiFailure } from "@/services/auth/authenticate-request.server";
import { getAdminDb } from "@/services/firebase/admin";

/** Whether this deployment can run a Revision Session at all. */
export function revisionSessionsEnabled() {
  return (
    featureFlags.enableRevisionSessions &&
    featureFlags.enableLearnerProfile &&
    featureFlags.enableStudyActions
  );
}

/** The routes' answer when the surface is off, so an unused deployment reveals nothing. */
export function revisionSessionsUnavailable() {
  if (!revisionSessionsEnabled()) return apiFailure("Not found", 404, "not_found");
  if (!isAnyAiProviderConfigured()) {
    return apiFailure("Jami's teaching isn't switched on here.", 503, "ai_unavailable");
  }
  return null;
}

/**
 * What the model is told about the subject, read from the student's own folder.
 *
 * The course and level, to pitch the lesson, and -- when asked for -- a few
 * passages of their course material on the concept, to teach it in their
 * course's terms. Never their marks, their answers or anything they typed: a
 * lesson is about the concept, and what the student knows is the engine's
 * business, not the prompt's.
 */
export async function loadRevisionConceptContext(
  uid: string,
  target: RevisionTarget,
  options: {
    /** Search the folder's own material for this, and teach from what is found. */
    materialQuery?: string;
  } = {}
): Promise<RevisionConceptContext> {
  const [context, material] = await Promise.all([
    loadFolderCourse(uid, target),
    options.materialQuery && target.folderId
      ? loadRevisionCourseMaterial(uid, target.folderId, options.materialQuery)
      : Promise.resolve([]),
  ]);
  return material.length > 0 ? { ...context, material } : context;
}

/** Passages of course material a lesson or an answer is given. */
const MATERIAL_PASSAGES = 3;
const MATERIAL_PASSAGE_CHARS = 1_200;
/** A search that has not come back by then costs the lesson its grounding, not its start. */
const MATERIAL_TIMEOUT_MS = 6_000;

/**
 * The few passages of the folder's own material closest to the concept.
 *
 * Asked for only when the student has started a session or asked a question
 * in one, and read for that request alone: nothing found is stored, and a
 * slow or failed search leaves the lesson to be taught as it always was.
 */
async function loadRevisionCourseMaterial(
  uid: string,
  folderId: string,
  query: string
): Promise<RevisionMaterialPassage[]> {
  const search = async () => {
    const snapshot = await getAdminDb()
      .collection("users")
      .doc(uid)
      .collection("sources")
      .where("status", "==", "active")
      .where("folderIds", "array-contains", folderId)
      .limit(30)
      .get();
    if (snapshot.empty) return [];
    const evidence = await retrieveTutorEvidence({
      uid,
      pinnedSourceIds: [],
      relatedSourceIds: snapshot.docs.map((document) => document.id),
      query,
      pinnedLimit: 0,
      relatedLimit: MATERIAL_PASSAGES,
    });
    return (evidence?.passages ?? [])
      .slice()
      .sort((left, right) => (left.distance ?? 1) - (right.distance ?? 1))
      .slice(0, MATERIAL_PASSAGES)
      .map((chunk) => ({
        title: chunk.sourceTitle,
        location: [
          chunk.sectionLabel ?? chunk.heading ?? "",
          chunk.pageStart === undefined ? "" : `page ${chunk.pageStart}`,
        ]
          .filter(Boolean)
          .join(", "),
        text: chunk.text.slice(0, MATERIAL_PASSAGE_CHARS),
      }));
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      search(),
      new Promise<RevisionMaterialPassage[]>((resolve) => {
        timer = setTimeout(() => resolve([]), MATERIAL_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function loadFolderCourse(uid: string, target: RevisionTarget): Promise<RevisionConceptContext> {
  const context: RevisionConceptContext = { conceptLabel: target.conceptLabel };
  if (!target.folderId) return context;
  try {
    const snapshot = await getAdminDb()
      .collection("users")
      .doc(uid)
      .collection("studyFolders")
      .doc(target.folderId)
      .get();
    if (!snapshot.exists) return context;
    const folder = mapStudyFolderData(snapshot.id, snapshot.data() as Record<string, unknown>);
    const course = folder.examCourse
      ? [folder.examCourse.board, folder.examCourse.qualification, folder.examCourse.specificationTitle]
          .filter(Boolean)
          .join(" ")
      : "";
    return {
      ...context,
      ...(course ? { course } : {}),
      ...(folder.studyLevel ? { level: String(folder.studyLevel) } : {}),
    };
  } catch {
    // A lesson pitched without the course is still a lesson.
    return context;
  }
}

/** What every session route answers with. */
export function revisionSessionResponse(
  record: RevisionSessionRecord,
  extra: { feedback?: string; selfGrade?: { answer: string; solution: string } } = {},
  status = 200
) {
  return Response.json({ session: projectRevisionSession(record), ...extra }, { status });
}
