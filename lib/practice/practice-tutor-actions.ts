/**
 * The ways into Tutor from a marked Past Paper Practice answer.
 *
 * Tutor already has the question, the student's answer and working, the mark,
 * the feedback and the mark scheme for this request (`resolvePracticeContext`,
 * with its permission checks). These only say what to do with them.
 *
 * "Why did I lose marks?" goes through the scheme a mark at a time, which is
 * the question a student actually has after a mark; Tutor may look in their
 * own notes for what a missed point needed. It explains a mark already given,
 * and never gives or changes one.
 */
export const PRACTICE_TUTOR_QUICK_ACTIONS = [
  {
    label: "Why did I lose marks?",
    prompt:
      "Go through the mark scheme for this question point by point. For each mark I didn't get, say what it was for, what in my answer or working fell short, and what would have earned it. Where my own notes cover something I missed, point me to it. End with the one thing to practise.",
  },
  {
    label: "Teach the missing idea",
    prompt: "Teach me the idea I was missing, then give me one small check question.",
  },
] as const;
