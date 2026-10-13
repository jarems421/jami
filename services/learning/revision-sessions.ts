import type { RevisionConceptOption } from "@/lib/revision/options";
import type { RevisionSessionView } from "@/lib/revision/view";
import { auth } from "@/services/firebase/client";
import { withTimeout } from "@/services/firebase/firestore";

/**
 * The session screen's line to its routes.
 *
 * Everything a Revision Session knows lives on the server; the screen only ever
 * holds the current step as the server chose to show it. So every call here
 * returns the whole session view, and the screen renders what it is given
 * rather than working out what should come next.
 */

/** Starting re-derives the student's recommendations, which reads their folders. */
const START_MS = 30_000;
/** The lesson is the longest thing the model writes for a student. */
const PREPARE_MS = 95_000;
/** A second explanation or a mark, with room for the provider's own retry. */
const STEP_MS = 50_000;
const READ_MS = 15_000;
/** A search of their material and a short answer. */
const ASK_MS = 45_000;

export class RevisionSessionError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "RevisionSessionError";
    this.code = code;
    this.status = status;
  }
}

type RouteReply = {
  session?: RevisionSessionView;
  folder?: { id: string; name: string };
  options?: RevisionConceptOption[];
  feedback?: string;
  selfGrade?: { answer: string; solution: string };
  error?: string;
  code?: string;
};

function isSessionView(value: unknown): value is RevisionSessionView {
  const record = value as Partial<RevisionSessionView> | null;
  return Boolean(record && typeof record.id === "string" && typeof record.status === "string");
}

async function call(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
  timeoutMs: number,
  label: string
) {
  const user = auth.currentUser;
  if (!user) throw new RevisionSessionError("You are not signed in.", "unauthorized", 401);
  const token = await user.getIdToken();
  const response = await withTimeout(
    fetch(path, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
    timeoutMs,
    label
  );
  const data = ((await response.json().catch(() => null)) ?? {}) as RouteReply;
  return { status: response.status, ok: response.ok, data };
}

function failure(status: number, data: RouteReply, fallback: string) {
  return new RevisionSessionError(
    typeof data.error === "string" ? data.error : fallback,
    typeof data.code === "string" ? data.code : "failed",
    status
  );
}

/** Start from a recommendation, or from a concept the student chose in a folder. */
export async function startRevisionSession(
  input: string | { folderId: string; topicKey: string }
): Promise<RevisionSessionView> {
  const { status, ok, data } = await call(
    "/api/learning/revision-sessions",
    { method: "POST", body: typeof input === "string" ? { actionId: input } : input },
    START_MS,
    "Start revision session"
  );
  if (!ok || !isSessionView(data.session)) {
    throw failure(status, data, "Jami couldn't start this session just now.");
  }
  return data.session;
}

/** What can be revised in one folder, most useful first. */
export async function getRevisionOptions(
  folderId: string
): Promise<{ folder: { id: string; name: string }; options: RevisionConceptOption[] }> {
  const { status, ok, data } = await call(
    `/api/learning/revision-sessions/options?folderId=${encodeURIComponent(folderId)}`,
    { method: "GET" },
    START_MS,
    "Load revision topics"
  );
  if (!ok || !data.folder || !Array.isArray(data.options)) {
    throw failure(status, data, "Jami couldn't list this folder's topics just now.");
  }
  return { folder: data.folder, options: data.options };
}

export async function getRevisionSession(sessionId: string): Promise<RevisionSessionView> {
  const { status, ok, data } = await call(
    `/api/learning/revision-sessions/${encodeURIComponent(sessionId)}`,
    { method: "GET" },
    READ_MS,
    "Load revision session"
  );
  if (!ok || !isSessionView(data.session)) {
    throw failure(status, data, "This session could not be opened.");
  }
  return data.session;
}

/**
 * Ask for the lesson to be written.
 *
 * `pending` means another request is already writing it -- the screen waits
 * and reads again rather than asking twice.
 */
export async function prepareRevisionSession(
  sessionId: string
): Promise<{ session: RevisionSessionView; pending: boolean }> {
  const { status, ok, data } = await call(
    `/api/learning/revision-sessions/${encodeURIComponent(sessionId)}/prepare`,
    { method: "POST" },
    PREPARE_MS,
    "Prepare revision session"
  );
  if (!ok || !isSessionView(data.session)) {
    throw failure(status, data, "Jami couldn't prepare this session just now.");
  }
  return { session: data.session, pending: status === 202 };
}

export type RevisionStepInput =
  | { type: "continue" }
  | { type: "hint" }
  | { type: "skip" }
  | { type: "answer"; answer: string }
  | { type: "self-grade"; correct: boolean };

export type RevisionStepReply = {
  session: RevisionSessionView;
  /** One or two sentences about the answer just marked. Shown once, never stored. */
  feedback?: string;
  /** The marker could not say, so the student judges this one against the answer. */
  selfGrade?: { answer: string; solution: string };
  /** The session had moved on elsewhere; `session` is where it now stands. */
  conflict: boolean;
};

export async function sendRevisionStep(
  sessionId: string,
  input: RevisionStepInput
): Promise<RevisionStepReply> {
  const { status, ok, data } = await call(
    `/api/learning/revision-sessions/${encodeURIComponent(sessionId)}/step`,
    { method: "POST", body: input },
    STEP_MS,
    "Revision session step"
  );
  if (status === 409 && isSessionView(data.session)) {
    return { session: data.session, conflict: true };
  }
  if (!ok || !isSessionView(data.session)) {
    throw failure(status, data, "Couldn't reach Jami. Try again.");
  }
  return {
    session: data.session,
    ...(typeof data.feedback === "string" ? { feedback: data.feedback } : {}),
    ...(data.selfGrade ? { selfGrade: data.selfGrade } : {}),
    conflict: false,
  };
}

/** A question about the step on screen. The answer is shown once and kept nowhere. */
export async function askRevisionQuestion(sessionId: string, question: string): Promise<string> {
  const { status, ok, data } = await call(
    `/api/learning/revision-sessions/${encodeURIComponent(sessionId)}/ask`,
    { method: "POST", body: { question } },
    ASK_MS,
    "Ask about a revision step"
  );
  const answer = (data as RouteReply & { answer?: unknown }).answer;
  if (!ok || typeof answer !== "string" || !answer.trim()) {
    throw failure(status, data, "Jami couldn't answer that just now. Try again.");
  }
  return answer;
}
