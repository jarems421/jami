import { featureFlags } from "@/lib/app/feature-flags";

/** Structurally what `ViewTabs` renders, without reaching into it. */
export type TutorView = {
  href: string;
  label: string;
  detail: string;
};

/**
 * The tutor and the material it reads are one surface.
 *
 * Sources used to carry the sidebar entry, which named the filing cabinet
 * rather than the reason a student opens it. Everything Jami does with a
 * student's own material starts here: choosing what it should read, asking it,
 * and reviewing the cards and questions it drafts.
 *
 * Deliberately not called context. Jami reads what it is handed, when it is
 * asked, and keeps none of it -- naming this "Jami's context" would promise a
 * memory it does not have, and a student who believed it would ask about a
 * source they had not selected and be quietly answered from general knowledge.
 */
export const TUTOR_VIEWS: TutorView[] = [
  {
    href: "/dashboard/tutor",
    label: "Ask Jami",
    detail: "Questions and drafts to review",
  },
  /*
   * Planning is Jami's, not Today's.
   *
   * A revision plan is made by talking to the tutor about what is coming up, so
   * it belongs beside the other things a student asks Jami for rather than as
   * an entry of its own in the sidebar. Today shows the day it produces; this
   * is where the plan itself is decided.
   */
  ...(featureFlags.enableRevisionPlans
    ? [
        {
          href: "/dashboard/tutor/plan",
          label: "Revision plan",
          detail: "Shape your week with Jami",
        },
      ]
    : []),
  /*
   * What Jami remembers about the student and how it teaches them, as a view
   * of its own rather than a settings button in the corner: the memory galaxy
   * is the student's, and it should be as easy to find as asking.
   */
  ...(featureFlags.enableTutorPersonalisation
    ? [
        {
          href: "/dashboard/tutor/personalise",
          label: "Your Jami",
          detail: "What Jami remembers and how it teaches you",
        },
      ]
    : []),
  {
    href: "/dashboard/library",
    label: "Sources",
    detail: "Material Jami can read",
  },
];

export const TUTOR_TITLE = "Jami";

export type SourcePanelLink = {
  sourceId: string | null;
  panel: "tutor" | "drafts" | null;
};

/** Opens the Sources view with one source already chosen and a panel showing. */
export function getSourcePanelHref(
  sourceId: string,
  panel: "tutor" | "drafts"
) {
  return `/dashboard/library?source=${encodeURIComponent(sourceId)}&panel=${panel}`;
}

/**
 * Reads that link back, from a query string.
 *
 * Takes the search string rather than calling `useSearchParams`, matching how
 * `useLibraryBrowser` already reads the URL on this page. Only the two panels
 * a link may name are accepted: `details` is reached by choosing a source, not
 * by being sent to one.
 */
export function readSourcePanelLink(search: string): SourcePanelLink {
  const params = new URLSearchParams(search);
  const sourceId = params.get("source")?.trim() || null;
  const panel = params.get("panel");

  return {
    sourceId,
    panel: panel === "tutor" || panel === "drafts" ? panel : null,
  };
}
