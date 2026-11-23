import { mapVideoCardJobData, type CardImportSourceKind, type VideoCardDraft, type VideoCardJob, type VideoCoverage } from "@/lib/ai/video-card-jobs";
import { mapCardData, type Card } from "@/lib/study/cards";
import { auth } from "@/services/firebase/client";
import { reportAllowanceRefusal } from "@/services/billing/allowance-events";

async function request(path: string, init?: RequestInit) {
  const user = auth.currentUser; if (!user) throw new Error("Sign in again to create cards from a source.");
  const response = await fetch(path, { ...init, headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), Authorization: `Bearer ${await user.getIdToken()}`, ...init?.headers } });
  const data = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    reportAllowanceRefusal(data);
    throw new Error(typeof data?.error === "string" ? data.error : "Jami could not process that source.");
  }
  return data ?? {};
}

export async function createVideoCardJob(input: { id: string; sourceKind: CardImportSourceKind; youtubeUrl?: string; storagePath?: string; fileName?: string; mimeType?: string; durationSeconds?: number; contentText?: string; deckId: string; topicIds: string[]; coverage: VideoCoverage; focus?: string }) {
  const data = await request("/api/ai/video-card-jobs", { method: "POST", headers: { "x-idempotency-key": input.id }, body: JSON.stringify(input) });
  return mapVideoCardJobData(input.id, data);
}
export async function getVideoCardJob(id: string): Promise<VideoCardJob> { return mapVideoCardJobData(id, await request(`/api/ai/video-card-jobs/${encodeURIComponent(id)}`)); }
export async function getRecentVideoCardJobs(): Promise<VideoCardJob[]> { const data = await request("/api/ai/video-card-jobs"); return Array.isArray(data.jobs) ? data.jobs.flatMap((item) => item && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string" ? [mapVideoCardJobData(String((item as Record<string, unknown>).id), item as Record<string, unknown>)] : []) : []; }
export async function saveVideoCardDrafts(id: string, drafts: VideoCardDraft[]) { return mapVideoCardJobData(id, await request(`/api/ai/video-card-jobs/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ drafts }) })); }
export async function requestMoreSourceCards(id: string, focus: string, updatedAt: number, drafts: VideoCardDraft[]) {
  const data = await request(`/api/ai/video-card-jobs/${encodeURIComponent(id)}/more`, {
    method: "POST", body: JSON.stringify({ focus, updatedAt, drafts }),
  });
  return mapVideoCardJobData(id, data);
}
export async function cancelVideoCardJob(id: string) { return mapVideoCardJobData(id, await request(`/api/ai/video-card-jobs/${encodeURIComponent(id)}`, { method: "DELETE" })); }
export async function approveVideoCardJob(id: string): Promise<Card[]> { const data = await request(`/api/ai/video-card-jobs/${encodeURIComponent(id)}/approve`, { method: "POST" }); return Array.isArray(data.cards) ? data.cards.flatMap((item) => item && typeof item === "object" ? [mapCardData(String((item as Record<string, unknown>).id), item as Record<string, unknown>)] : []) : []; }
