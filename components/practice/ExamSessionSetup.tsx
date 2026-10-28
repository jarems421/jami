"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@/components/providers/UserProvider";
import { Button, Card, EmptyState, FeedbackBanner, Select, Skeleton } from "@/components/ui";
import OptionSwitch from "@/components/ui/OptionSwitch";
import SettingSwitch from "@/components/ui/SettingSwitch";
import { jamiShareOfMix } from "@/lib/practice/exam-exemplars";
import {
  examCalculatorChoiceOffered,
  examPaperLabelWithin,
  type ExamCoursePaper,
} from "@/lib/practice/exam-papers";
import type { ExamCalculatorChoice, ExamDifficulty } from "@/lib/practice/exam-questions";
import { EXAM_SESSION_MAX_QUESTIONS, examBoardAppliesTo } from "@/lib/practice/exam-questions";
import type { StudyFolder } from "@/lib/workspace/study-folders";
import { getActiveStudyFolders } from "@/services/study/folders";
import {
  createPastPaperPracticeSession,
  getExamAvailability,
  readCoverageShortage,
  type ExamCoverageShortage,
} from "@/services/study/exam-practice";
import ExamCourseSetup from "@/components/practice/ExamCourseSetup";
import ExamGenerationProgress from "@/components/practice/ExamGenerationProgress";
import CreateFolderDialog from "@/components/workspace/CreateFolderDialog";

const DIFFICULTIES: Array<{ id: ExamDifficulty; label: string; note: string }> = [
  { id: "easy", label: "Easy", note: "Things everyone on the course should know" },
  { id: "medium", label: "Medium", note: "Exam-standard, a few steps of reasoning" },
  { id: "hard", label: "Hard", note: "The ones that separate the top grades" },
];

const CALCULATOR_CHOICES: Array<{ value: ExamCalculatorChoice; label: string }> = [
  { value: "any", label: "Either" },
  { value: "non_calculator", label: "Non-calculator" },
  { value: "calculator", label: "Calculator" },
];

const ALL_PAPERS = "all";
const ALL_PARTS = "all";

const MAX_QUESTIONS = EXAM_SESSION_MAX_QUESTIONS;

function totalOf(mix: Record<ExamDifficulty, number>) {
  return mix.easy + mix.medium + mix.hard;
}

/** A topic the course names, with the finer concepts beneath it where it has a checked list. */
type ExamTopicOption = {
  id: string;
  label: string;
  /** The part of the course it belongs to, on a course sat as several subjects. */
  group?: string;
  concepts?: Array<{ id: string; label: string }>;
};

/**
 * A topic's name inside a part already chosen.
 *
 * The catalogue writes Combined Science's topics as "Biology: Cell biology",
 * because across the whole course that is what tells them apart. Once a
 * student has said Biology, every line saying so again is noise in front of
 * the word they are actually reading.
 */
function topicLabelWithin(topic: ExamTopicOption, part: string) {
  if (!part || topic.group !== part) return topic.label;
  const prefix = `${part}: `;
  return topic.label.startsWith(prefix) ? topic.label.slice(prefix.length) : topic.label;
}

export default function ExamSessionSetup({
  initialFolderId = "",
  initialTopicIds,
  initialConceptIds,
  originNotebookId,
}: {
  initialFolderId?: string;
  /** Topics to start narrowed to; the server still checks them against the course. */
  initialTopicIds?: string[];
  /** Concepts to start narrowed to, checked the same way. */
  initialConceptIds?: string[];
  originNotebookId?: string;
}) {
  const { user } = useUser();
  const router = useRouter();
  const [folders, setFolders] = useState<StudyFolder[]>([]);
  const [folderId, setFolderId] = useState(initialFolderId);
  const [mix, setMix] = useState<Record<ExamDifficulty, number>>({ easy: 2, medium: 3, hard: 0 });
  // Keyed by folder so switching folders shows "checking" without an effect
  // reaching back in to clear it.
  const [availability, setAvailability] = useState<{
    folderId: string;
    counts: Record<ExamDifficulty, number>;
    /** The count stopped at a session's worth; there are more behind it. */
    hasMore: Record<ExamDifficulty, boolean>;
  } | null>(null);
  /*
   * Which paper, in the words every subject uses for it.
   *
   * Papers split a course by what they examine -- micro and macro economics,
   * different biology topics -- so "Paper 2" is how a student names the half
   * of the course they want. The calculator question is maths's version of
   * the same thing, and it is asked only on a course whose papers carry a
   * calculator rule; the folder that answered yes is remembered so narrowing
   * to one paper does not make the question vanish.
   */
  const [paperId, setPaperId] = useState(ALL_PAPERS);
  const [papers, setPapers] = useState<ExamCoursePaper[]>([]);
  /**
   * Which part of the course is being practised, where the course is sat as
   * more than one subject.
   *
   * Combined Science is one qualification and three sciences, so its papers
   * and its topic list held Biology, Chemistry and Physics at once: twenty-one
   * topics in one flat run, and a session that drew from all three unless a
   * single paper was picked. They are the same course and stay one course --
   * this only decides which part of it is on screen.
   *
   * Triple science needs nothing here: Biology, Chemistry and Physics are
   * already three separate courses in the catalogue, so a folder set to one of
   * them only ever had that one.
   */
  const [part, setPart] = useState(ALL_PARTS);
  const [calculator, setCalculator] = useState<ExamCalculatorChoice>("any");
  const [calculatorFolderId, setCalculatorFolderId] = useState("");
  const [topics, setTopics] = useState<ExamTopicOption[]>([]);
  const [topicIds, setTopicIds] = useState<string[]>(() => initialTopicIds ?? []);
  const [conceptIds, setConceptIds] = useState<string[]>(() => initialConceptIds ?? []);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  /** Jami's own exam-style questions as a share of the session; on unless the student turns it off. */
  const [includeJami, setIncludeJami] = useState(true);
  const [shortage, setShortage] = useState<ExamCoverageShortage | null>(null);
  /** Jami-created questions being written: how many, and since when. */
  const [generating, setGenerating] = useState<{ count: number; startedAt: number } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [courseRevision, setCourseRevision] = useState(0);
  const [createFolderOpen, setCreateFolderOpen] = useState(false);

  useEffect(() => {
    let active = true;
    void getActiveStudyFolders(user.uid)
      .then((items) => {
        if (!active) return;
        const eligible = items.filter((folder) => examBoardAppliesTo(folder.studyLevel));
        setFolders(eligible);
        // A folder that already knows its course can start straight away; one that does not has to be set up first.
        const ready = eligible.find((folder) => folder.examCourse) ?? eligible[0];
        setFolderId((current) => current || ready?.id || "");
      })
      .catch(() => setError("Your folders could not be loaded."))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [user.uid]);

  /**
   * The parts this course is sat in, in the order the catalogue names them.
   *
   * Taken from the papers and the topics together: a course early in ingestion
   * may have a checked topic list before it has a question from every paper.
   */
  const parts = useMemo(() => {
    const seen: string[] = [];
    for (const group of [
      ...papers.map((paper) => paper.group),
      ...topics.map((topic) => topic.group),
    ]) {
      if (group && !seen.includes(group)) seen.push(group);
    }
    return seen;
  }, [papers, topics]);
  const showParts = parts.length > 1;
  const partChosen = showParts && part !== ALL_PARTS;
  const visiblePapers = useMemo(
    () => (partChosen ? papers.filter((paper) => paper.group === part) : papers),
    [papers, part, partChosen]
  );
  const visibleTopics = useMemo(
    () => (partChosen ? topics.filter((topic) => topic.group === part) : topics),
    [topics, part, partChosen]
  );
  /*
   * A part narrows to its own papers, which is how the questions themselves
   * are told apart -- there is nothing on a question that says "Biology" other
   * than the paper it came off. A single paper chosen inside a part is
   * narrower still and wins.
   */
  const paperIdsAsked = useMemo(() => {
    if (paperId !== ALL_PAPERS) return [paperId];
    return partChosen ? visiblePapers.map((paper) => paper.id) : [];
  }, [paperId, partChosen, visiblePapers]);
  /** Stable while the ids are, so asking for availability does not loop. */
  const paperKey = paperIdsAsked.join(",");

  useEffect(() => {
    if (!folderId) return;
    let active = true;
    void getExamAvailability(folderId, topicIds, calculator, paperKey ? paperKey.split(",") : [], conceptIds)
      .then((result) => {
        if (!active) return;
        setAvailability({ folderId, counts: result.counts, hasMore: result.hasMore });
        setTopics(result.topics);
        setPapers(result.papers ?? []);
        if (result.calculatorPolicyKnown) setCalculatorFolderId(folderId);
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : "Question availability could not be loaded.");
        }
      });
    return () => {
      active = false;
    };
  }, [calculator, conceptIds, courseRevision, folderId, paperKey, topicIds]);

  const counts = availability?.folderId === folderId ? availability.counts : null;
  const hasMore = availability?.folderId === folderId ? availability.hasMore : null;
  const total = totalOf(mix);
  const jamiCount = includeJami ? totalOf(jamiShareOfMix(mix)) : 0;
  const narrowedCount = topicIds.length + conceptIds.length;
  const selectedFolder = folders.find((folder) => folder.id === folderId);
  const ready = Boolean(folderId && selectedFolder?.examCourse && total > 0);
  const showPapers = visiblePapers.length > 1;
  const showCalculator = examCalculatorChoiceOffered({
    paperChosen: paperId !== ALL_PAPERS,
    policyKnown: calculatorFolderId === folderId,
    calculatorChosen: calculator !== "any",
  });
  const paperDetails = visiblePapers.some((paper) => paper.detail);
  const paperOptions = [
    {
      value: ALL_PAPERS,
      label: "All papers",
      ...(paperDetails ? { detail: partChosen ? `Anything in ${part}` : "Anything on the course" } : {}),
    },
    ...visiblePapers.map((paper) => ({
      value: paper.id,
      label: partChosen ? examPaperLabelWithin(paper, part) : paper.label,
      detail: paper.detail,
    })),
  ];
  const partOptions = [
    { value: ALL_PARTS, label: "All", detail: "Draw from the whole course" },
    ...parts.map((name) => ({ value: name, label: name, detail: `Only ${name}` })),
  ];

  /*
   * A part is a different course to practise, so nothing chosen inside the
   * last one carries over: a Chemistry paper is not a paper of Biology's, and
   * a topic picked under Physics would silently narrow a Biology session to
   * nothing.
   */
  const selectPart = (value: string) => {
    setPart(value);
    setPaperId(ALL_PAPERS);
    setCalculator("any");
    setShortage(null);
    if (value === ALL_PARTS) return;
    const kept = new Set(
      topics.filter((topic) => topic.group === value).map((topic) => topic.id)
    );
    const keptConcepts = new Set(
      topics
        .filter((topic) => topic.group === value)
        .flatMap((topic) => (topic.concepts ?? []).map((concept) => concept.id))
    );
    setTopicIds((current) => current.filter((id) => kept.has(id)));
    setConceptIds((current) => current.filter((id) => keptConcepts.has(id)));
  };

  const selectFolder = (id: string) => {
    setFolderId(id);
    setTopicIds([]);
    setConceptIds([]);
    setTopics([]);
    setPaperId(ALL_PAPERS);
    setPapers([]);
    setPart(ALL_PARTS);
    setCalculator("any");
    setShortage(null);
  };

  /*
   * A folder made here is practised here. Its level and course are asked as
   * it is created, so a school folder arrives ready to pick; any other level
   * cannot draw exam questions, which is said rather than silently ignored.
   */
  const handleFolderCreated = (folder: StudyFolder) => {
    if (!examBoardAppliesTo(folder.studyLevel)) {
      setNotice(
        `“${folder.name}” was created. Set its level to School, GCSE or A level to practice it here.`
      );
      return;
    }
    setFolders((current) => [folder, ...current.filter((item) => item.id !== folder.id)]);
    selectFolder(folder.id);
  };

  /*
   * A whole topic and single concepts inside it are two ways of asking for the
   * same questions, so choosing one clears the other: ticking a topic replaces
   * the concepts picked beneath it, and picking a concept unticks its topic.
   */
  const toggleTopic = (topic: ExamTopicOption) => {
    const selecting = !topicIds.includes(topic.id);
    setTopicIds((current) =>
      selecting ? [...current, topic.id] : current.filter((id) => id !== topic.id)
    );
    if (selecting) {
      const inside = new Set((topic.concepts ?? []).map((concept) => concept.id));
      setConceptIds((current) => current.filter((id) => !inside.has(id)));
    }
  };

  const toggleConcept = (topic: ExamTopicOption, conceptId: string) => {
    const selecting = !conceptIds.includes(conceptId);
    setConceptIds((current) =>
      selecting ? [...current, conceptId] : current.filter((id) => id !== conceptId)
    );
    if (selecting) setTopicIds((current) => current.filter((id) => id !== topic.id));
  };

  const createFolderDialog = (
    <CreateFolderDialog
      open={createFolderOpen}
      userId={user.uid}
      onClose={() => setCreateFolderOpen(false)}
      onCreated={handleFolderCreated}
    />
  );

  const noticeBanner = notice ? (
    <FeedbackBanner type="success" message={notice} onDismiss={() => setNotice("")} />
  ) : null;

  const change = (difficulty: ExamDifficulty, delta: number) => {
    setShortage(null);
    setMix((current) => {
      if (delta > 0 && totalOf(current) >= MAX_QUESTIONS) return current;
      return { ...current, [difficulty]: Math.max(0, current[difficulty] + delta) };
    });
  };

  /*
   * There is one button, and it starts.
   *
   * A shortage is not something to make a student hunt for in advance: the
   * counts are on screen, and if the bank still cannot fill the mix the server
   * says so in the same round trip, along with what it could supply. Looking
   * for more papers happens behind that answer, not in front of it.
   */
  const start = async (
    options: { allowGenerated?: boolean; useAvailableOnly?: boolean; generatedCount?: number } = {}
  ) => {
    const { generatedCount, ...requestOptions } = options;
    setStarting(true);
    setError("");
    if (requestOptions.allowGenerated) {
      setGenerating({ count: generatedCount ?? 0, startedAt: Date.now() });
    } else if (jamiCount > 0) {
      setGenerating({ count: jamiCount, startedAt: Date.now() });
    }
    try {
      const session = await createPastPaperPracticeSession({
        folderId,
        mix,
        topicIds,
        conceptIds,
        originNotebookId,
        calculator,
        paperIds: paperIdsAsked,
        includeJami,
        ...requestOptions,
      });
      // The progress stays up until the session page replaces this one.
      router.push(`/dashboard/practice/questions/${session.id}`);
    } catch (reason) {
      const gap = readCoverageShortage(reason);
      if (gap) setShortage(gap);
      else setError(reason instanceof Error ? reason.message : "This session could not be started.");
      setGenerating(null);
      setStarting(false);
    }
  };

  if (loading) {
    return (
      <div className="grid gap-4">
        <Skeleton className="h-28" />
        <Skeleton className="h-72" />
      </div>
    );
  }

  if (folders.length === 0) {
    return (
      <div className="space-y-5">
        {createFolderDialog}
        {noticeBanner}
        <EmptyState
          title="No school folders yet"
          description="Past Paper Practice works inside a School, GCSE or A level folder. Create one and choose your exam board and course as you go."
          action={
            <Button type="button" onClick={() => setCreateFolderOpen(true)}>
              Create folder
            </Button>
          }
        />
      </div>
    );
  }

  const missingTotal = shortage
    ? Object.values(shortage.missingByDifficulty).reduce((sum, value) => sum + (value ?? 0), 0)
    : 0;
  const availableTotal = shortage ? totalOf(shortage.availableMix) : 0;

  return (
    <div className="space-y-5">
      {createFolderDialog}
      {error ? <FeedbackBanner type="error" message={error} onDismiss={() => setError("")} /> : null}
      {noticeBanner}

      <Card tone="warm" padding="lg">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-text-secondary">
          Past Paper Practice
        </p>
        <h2 className="mt-3 text-2xl font-medium tracking-tight text-text-primary sm:text-3xl">
          Choose your questions
        </h2>
        <p className="mt-2 max-w-xl text-sm leading-6 text-text-muted">
          A short set of real questions, marked one at a time with the official scheme.
        </p>
        <div className="mt-6 flex max-w-xl flex-col gap-2 sm:flex-row sm:items-end">
          <Select
            label="Study folder"
            value={folderId}
            containerClassName="min-w-0 flex-1"
            onChange={(event) => selectFolder(event.target.value)}
          >
            <option value="">Choose a folder</option>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
                {folder.subject ? ` · ${folder.subject}` : ""}
              </option>
            ))}
          </Select>
          <Button
            type="button"
            variant="secondary"
            className="sm:min-h-[3.25rem]"
            onClick={() => setCreateFolderOpen(true)}
          >
            New folder
          </Button>
        </div>
      </Card>

      {selectedFolder && !selectedFolder.examCourse ? (
        <ExamCourseSetup
          userId={user.uid}
          folder={selectedFolder}
          onSaved={(updated) => {
            setFolders((current) => current.map((item) => (item.id === updated.id ? updated : item)));
            setCourseRevision((value) => value + 1);
          }}
        />
      ) : null}

      {selectedFolder?.examCourse && (showParts || showPapers || showCalculator) ? (
        <Card padding="md">
          <h3 className="text-lg font-semibold text-text-primary">
            {showParts ? "Which part of the course?" : "Which papers?"}
          </h3>
          <p className="mt-1 text-sm leading-5 text-text-muted">
            {showParts
              ? `This course is sat as ${parts.join(", ").replace(/, ([^,]*)$/, " and $1")}. Practice one at a time, or draw from all of it.`
              : showPapers
              ? calculatorFolderId === folderId
                ? "Each paper examines a different part of the course and sets whether a calculator is allowed. Practice one, or draw from them all."
                : "Each paper examines a different part of the course. Practice one, or draw from them all."
              : "Practice with or without a calculator."}
          </p>
          {showParts ? (
            <OptionSwitch
              label="Part of the course"
              hideLabel
              className="mt-4"
              value={part}
              options={partOptions}
              columns={Math.min(partOptions.length, 5) as 3 | 4 | 5}
              detail="selected"
              onChange={selectPart}
            />
          ) : null}
          {showPapers ? (
            <OptionSwitch
              label="Paper"
              hideLabel
              className="mt-4"
              value={paperId}
              options={paperOptions}
              columns={Math.min(paperOptions.length, 5) as 3 | 4 | 5}
              // One line under the row for the paper chosen, so pressing a paper
              // says what it is without every tile carrying a description.
              detail="selected"
              onChange={(value) => {
                setPaperId(value);
                // A single paper carries its own calculator rule, so a choice
                // made across all papers would only contradict it.
                if (value !== ALL_PAPERS) setCalculator("any");
                setShortage(null);
              }}
            />
          ) : null}
          {showCalculator ? (
            <OptionSwitch
              label="Calculator"
              hideLabel={!showPapers}
              className="mt-4"
              value={calculator}
              options={CALCULATOR_CHOICES}
              onChange={(value) => {
                setCalculator(value);
                setShortage(null);
              }}
            />
          ) : null}
        </Card>
      ) : null}

      <div className="grid gap-3 md:grid-cols-3">
        {DIFFICULTIES.map(({ id, label, note }) => (
          <Card key={id} padding="md" className="flex min-h-48 flex-col justify-between">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-text-primary">{label}</h3>
                <p className="mt-1 text-sm leading-5 text-text-muted">{note}</p>
              </div>
              <span className="shrink-0 rounded-full bg-[var(--color-glass-subtle)] px-2.5 py-1 text-xs font-medium text-text-muted">
                {counts ? `${counts[id]}${hasMore?.[id] ? "+" : ""} ready` : "Checking…"}
              </span>
            </div>
            <div className="mt-6 flex items-center justify-between rounded-2xl border border-[var(--color-border)] bg-[var(--color-glass-subtle)] p-2">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`One fewer ${label.toLowerCase()} question`}
                disabled={mix[id] === 0}
                onClick={() => change(id, -1)}
              >
                −
              </Button>
              <span className="min-w-12 text-center text-2xl font-semibold tabular-nums text-text-primary">
                {mix[id]}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`One more ${label.toLowerCase()} question`}
                disabled={total >= MAX_QUESTIONS}
                onClick={() => change(id, 1)}
              >
                +
              </Button>
            </div>
          </Card>
        ))}
      </div>

      {/*
        * A course with no checked topic list says so.
        *
        * This rendered nothing at all, which is indistinguishable from a
        * feature that does not exist -- and a student who had seen topics on
        * another course had no way to tell whether they were missing something
        * or whether Jami was. Topics are fail-closed by design: an unchecked
        * list is worse than none, because a wrong topic silently narrows
        * practice to the wrong questions.
        */}
      {visibleTopics.length === 0 ? (
        <p className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-glass-subtle)] px-4 py-3 text-sm text-text-muted">
          Topics aren&apos;t available for this course yet, so this session draws on the whole
          specification. Nothing is missing from your practice.
        </p>
      ) : (
        <details className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-glass-subtle)] p-4">
          <summary className="cursor-pointer text-sm font-semibold text-text-primary">
            Narrow to {partChosen ? `${part.toLowerCase()} topics` : "topics"}
            {narrowedCount ? ` · ${narrowedCount} selected` : ""}
          </summary>
          <div className="mt-4 grid items-start gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {visibleTopics.map((topic) => {
              const concepts = topic.concepts ?? [];
              const chosenInside = concepts.filter((concept) => conceptIds.includes(concept.id)).length;
              return (
                <div
                  key={topic.id}
                  className="rounded-2xl px-3 py-2 transition hover:bg-[var(--color-glass-strong)]"
                >
                  <label className="flex cursor-pointer items-center gap-3 text-sm text-text-secondary">
                    <input
                      type="checkbox"
                      checked={topicIds.includes(topic.id)}
                      className="h-4 w-4 accent-[var(--color-accent)]"
                      onChange={() => toggleTopic(topic)}
                    />
                    {topicLabelWithin(topic, part)}
                  </label>
                  {/*
                    * Finer concepts fold away under their topic. A student who
                    * wants "quadratic equations" rather than all of solving
                    * equations opens the topic; one who does not never sees them.
                    */}
                  {concepts.length > 0 ? (
                    <details className="mt-1 pl-7">
                      <summary className="cursor-pointer text-xs text-text-muted">
                        {chosenInside > 0
                          ? `${chosenInside} of ${concepts.length} subtopics chosen`
                          : `Or choose from ${concepts.length} subtopics`}
                      </summary>
                      <div className="mt-2 grid gap-1">
                        {concepts.map((concept) => (
                          <label
                            key={concept.id}
                            className="flex cursor-pointer items-start gap-2 text-xs leading-5 text-text-secondary"
                          >
                            <input
                              type="checkbox"
                              checked={conceptIds.includes(concept.id)}
                              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--color-accent)]"
                              onChange={() => toggleConcept(topic, concept.id)}
                            />
                            {concept.label}
                          </label>
                        ))}
                      </div>
                    </details>
                  ) : null}
                </div>
              );
            })}
          </div>
        </details>
      )}

      {shortage ? (
        <Card tone="warm" padding="lg">
          {generating ? (
            <>
              <h3 className="text-lg font-semibold text-text-primary">
                Jami is writing your questions
              </h3>
              <p className="mt-1 max-w-xl text-sm leading-6 text-text-secondary">
                {generating.count} original Jami-created question{generating.count === 1 ? "" : "s"}
                {availableTotal > 0
                  ? `, alongside the ${availableTotal} real one${availableTotal === 1 ? "" : "s"}.`
                  : "."}
              </p>
              <ExamGenerationProgress count={generating.count} startedAt={generating.startedAt} />
            </>
          ) : (
            <>
          <h3 className="text-lg font-semibold text-text-primary">
            {availableTotal > 0
              ? `Only ${availableTotal} matching real question${availableTotal === 1 ? "" : "s"} so far`
              : "No matching real questions yet"}
          </h3>
          {/*
            * This used to say Jami was looking for more papers in the
            * background. Nothing was: the search it referred to has no caller,
            * and even if it ran, a past-paper question reaches students only
            * after the licence and the extraction have both been checked by a
            * person. So the card says what is actually true and offers the two
            * choices that actually exist, rather than implying a wait that
            * would never end.
            */}
          <p className="mt-2 max-w-xl text-sm leading-6 text-text-secondary">
            More real questions are added for this course as they are licensed and checked, which is
            not something you can wait for here. You can fill the gap with original Jami-created
            questions — clearly labelled, and not taken from a past paper — or start with the real
            ones there are.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button
              disabled={starting}
              onClick={() => void start({ allowGenerated: true, generatedCount: missingTotal })}
            >
              Add {missingTotal} Jami-created question{missingTotal === 1 ? "" : "s"}
            </Button>
            {availableTotal > 0 ? (
              <Button
                variant="secondary"
                disabled={starting}
                onClick={() => void start({ useAvailableOnly: true })}
              >
                Start with the {availableTotal} real one{availableTotal === 1 ? "" : "s"}
              </Button>
            ) : null}
            <Button variant="ghost" disabled={starting} onClick={() => setShortage(null)}>
              Change my mix
            </Button>
          </div>
            </>
          )}
        </Card>
      ) : null}

      <Card padding="md" className="space-y-4">
        <SettingSwitch
          label="Include Jami's exam-style questions"
          description={
            total >= 2
              ? `${jamiCount} of your ${total} questions will be new ones Jami writes, each modelled on a real question from this course with fresh numbers and wording. They are labelled Jami-created.`
              : "Add a second question to include one Jami writes in the style of this course's papers."
          }
          checked={includeJami}
          disabled={starting}
          onChange={setIncludeJami}
        />
        {starting && generating && !shortage ? (
          <div className="border-t border-[var(--color-border)] pt-4">
            <p className="text-sm font-semibold text-text-primary">
              Jami is writing {generating.count} question{generating.count === 1 ? "" : "s"} for you
            </p>
            <ExamGenerationProgress count={generating.count} startedAt={generating.startedAt} />
          </div>
        ) : null}
        <div className="flex flex-col gap-4 border-t border-[var(--color-border)] pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-text-primary">
              {total} question{total === 1 ? "" : "s"}
            </p>
            <p className="mt-1 max-w-md text-sm leading-5 text-text-muted">
              Your answer and your working are both saved and both sent to Jami for marking.
            </p>
          </div>
          <Button size="lg" disabled={!ready || starting} onClick={() => void start()} data-tutorial-target="start-exam">
            {starting ? "Starting…" : "Start practice"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
