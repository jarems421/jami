import type { AiContentPart } from "@/lib/ai/content-parts";

export type AiProvider = "openrouter" | "gemini";

export type AiRole =
  | "worker"
  | "supervisor"
  | "juror"
  | "research"
  | "documentVision"
  | "tutorImage"
  | "paperImage"
  | "embedding";

export type AiGenerationRole = Extract<
  AiRole,
  "worker" | "supervisor" | "juror" | "research" | "documentVision"
>;

export type AiTaskClass = "standard" | "important" | "visual";

export type AiRouteReason =
  | "routine"
  | "complex_request"
  | "many_sources"
  | "long_request"
  | "student_correction"
  | "second_correction"
  | "repeated_concept"
  | "student_preference"
  | "routing_preflight"
  | "low_confidence"
  | "insufficient_reasoning"
  | "explicit_role"
  | "provider_escalation"
  | "provider_failover"
  | "provider_standby"
  | "visual_specialist"
  /** A Tutor agent's planner choosing its next look-up (`tutor-agent.ts`). */
  | "agent_step"
  /** A Tutor agent's independent working of a problem, to check the answer against. */
  | "agent_check";

export type AiRouteDecision = {
  role: "worker" | "supervisor" | "juror";
  reason: AiRouteReason;
  taskClass: Exclude<AiTaskClass, "visual">;
};

export type AiCapability = {
  role: AiRole;
  provider: AiProvider;
  modelId: string;
  providerAllowlist: readonly string[];
  /** OpenRouter endpoint precision allowlist; empty for Google roles. */
  quantizations: readonly string[];
  modalities: readonly ("text" | "image" | "document" | "embedding")[];
  maxContextTokens: number;
  maxOutputTokens: number;
  reasoning: boolean;
  /**
   * A different model meeting the same bar, tried only after the primary has
   * already failed twice. The role's contract is unchanged — same allowlist
   * discipline, same precision floor, same output cap — so a standby is a
   * change of endpoint, never a relaxation of the requirements.
   */
  standby?: {
    modelId: string;
    providerAllowlist: readonly string[];
  };
};

export type AiProviderAttempt = {
  provider: AiProvider;
  role: AiGenerationRole;
  model: string;
  providerAllowlist: readonly string[];
  quantizations: readonly string[];
  thinking: boolean;
  reasoningEffort: AiReasoningEffort;
  routeReason: AiRouteReason;
};

export type AiReasoningEffort = "low" | "medium" | "high";

/**
 * How hard the model should think, scaled to how hard the question is.
 *
 * Reasoning is not free: measured on GLM 5.3 Flash, the same tutor question
 * took 12.4 seconds and 222 thinking tokens when the model was left to its own
 * default, and 4.4 seconds with none, for an answer that was 62 words instead
 * of 66. Spending that on "what does osmosis mean" buys nothing; spending it on
 * a disputed mark does.
 *
 * So the route already decided the difficulty, and this reads it rather than
 * asking again: routine work thinks little, the supervisor's papers and marking
 * think more, and a juror adjudicating a challenge thinks hardest. A student
 * can raise it for themselves, and the setting says what it costs in waiting.
 */
export function getReasoningEffort(
  role: AiGenerationRole,
  preference?: AiReasoningEffort
): AiReasoningEffort {
  const byRole: AiReasoningEffort =
    role === "juror" ? "high" : role === "supervisor" ? "medium" : "low";
  if (!preference) return byRole;
  // A preference raises the floor; it never lowers what the role needs, or a
  // student could quietly make their own disputed mark cheaper to adjudicate.
  const order: AiReasoningEffort[] = ["low", "medium", "high"];
  return order.indexOf(preference) > order.indexOf(byRole) ? preference : byRole;
}

export type AiProviderPolicy = {
  openRouterReady: boolean;
  geminiReady: boolean;
  jurorReady: boolean;
  capabilities: Readonly<Record<AiRole, AiCapability>>;
};

const DEFAULT_MODELS = {
  worker: "z-ai/glm-5.3-flash",
  supervisor: "qwen/qwen3.6-35b-a3b",
  juror: "moonshotai/kimi-k2.6",
  research: "gemini-3.5-flash-lite",
  documentVision: "gemini-3.5-flash-lite",
  // Flash-Lite Image drew convincing pictures with wrong details, and at 29 Sep
  // 2026 a side-by-side put the full model clearly ahead on realism. Labelled
  // diagrams no longer reach an image model at all, so this is only ever asked
  // what something looks like, and its extra cost is paid rarely.
  tutorImage: "gemini-3.1-flash-image",
  paperImage: "gemini-3.1-flash-image",
  embedding: "gemini-embedding-2",
} satisfies Record<AiRole, string>;

const DEFAULT_PROVIDERS = {
  /*
   * These defaults are intentionally limited to current full-context ZDR
   * endpoints. The live release check rejects stale entries before cutover.
   *
   * The worker's was `["parasail"]` against a `xiaomi/mimo-v2.5` model that
   * Parasail does not serve, so every routine tutor question failed closed with
   * OpenRouter's "No allowed providers are available for the selected model"
   * and the Tutor answered nothing at all. Papers and marking were unaffected,
   * because the supervisor's allowlist did contain an endpoint for its own
   * model -- which is why this read as "the AI tutor is broken" rather than as
   * an outage.
   *
   * Two things made it survivable for so long. `.env.local` set
   * OPENROUTER_WORKER_PROVIDERS to `novita,parasail`, so it always worked on a
   * developer machine; and the one compliant endpoint the model had was sitting
   * in DEFAULT_FAILOVER_PROVIDERS instead, which is only reached after a parsed
   * reply comes back empty -- never after a request that fails outright.
   *
   * It happened again in October 2026, more quietly. Z.ai and Novita serve the
   * model at fp8 but only plain `response_format`, not the strict JSON schema
   * Tutor sends, and Modal moved to nvfp4 -- so every worker call was refused in
   * a tenth of a second and every Tutor answer fell through to the supervisor,
   * which thinks for 2,600 tokens whatever effort it is asked for. "Low"
   * answered in eighteen seconds. The release check let it through because it
   * did not require `structured_outputs` of the worker; it does now.
   *
   * BaseTen and Morph pass every rule the request sets: fp8, strict structured
   * output, reasoning, full context, zero retention. Measured on a Tutor-sized
   * answer at effort low, the first words arrived in 1.4 to 1.6 seconds.
   */
  worker: ["baseten", "morph"],
  /*
   * Four endpoints, and a model measured against the job rather than assumed.
   *
   * This was MiniMax M3 on Parasail alone, and both halves were a problem. The
   * endpoint was the only compliant one the model had, it sat at `status: -2`,
   * and it answered HTTP 429 on three of three attempts under a trivial
   * benchmark -- while carrying paper generation and marking. And the model was
   * the weakest of the three that completed a run of the app's own mark-scheme
   * prompt:
   *
   *   kimi-k2.6           22/24 (92%)   $0.023   2 endpoints
   *   qwen3.6-35b-a3b     20/24 (83%)   $0.038   4 endpoints
   *   minimax-m3          14/24 (58%)   $0.024   2 endpoints
   *
   * Kimi scored highest and is deliberately not here: it is the juror, and a
   * juror that adjudicates its own supervisor's work is not independent of it.
   * Qwen takes the seat on the two things the role was short of -- twenty-five
   * points of accuracy and twice the endpoints -- and keeps worker, supervisor
   * and juror in three different model families.
   *
   * It costs about half as much again per batch and runs slower. That is the
   * trade, taken deliberately: papers and mark schemes are the last place to
   * economise, and the incumbent was failing 42 per cent of the checks.
   */
  supervisor: ["coreweave", "siliconflow", "akashml"],
  // Moonshot's own endpoint serves Kimi at INT4; SiliconFlow serves the same
  // model at FP8 on an equally full-context ZDR endpoint, so the juror is no
  // longer pinned to a single provider or to the lowest precision available.
  juror: ["moonshotai", "siliconflow", "parasail"],
} as const;

/**
 * Standbys, for roles where the approved endpoint pool is dangerously thin.
 *
 * The supervisor generates papers, marks as primary and adjudicates disputes,
 * and of the whole zero-retention catalogue exactly one endpoint serves its
 * model at full context with structured output support. Widening the allowlist
 * cannot help: the other endpoints for that model fail on context or do not
 * advertise structured responses at all. A second model is the only remedy.
 *
 * Kimi K3 on DeepInfra meets every supervisor requirement — full context,
 * BF16, multimodal, reasoning, structured outputs, zero retention. Note it
 * shares a family with the juror's K2.6: while the supervisor is on standby an
 * adjudication and its third view are no longer fully independent, which is a
 * real if temporary weakening. A correlated third view still beats a marking
 * run that cannot complete.
 */
const DEFAULT_STANDBY = {
  supervisor: {
    modelId: "moonshotai/kimi-k3",
    providerAllowlist: ["deepinfra"] as readonly string[],
  },
} as const;

/**
 * Where a role may deliberately go when its primary endpoint fails in a way
 * retrying cannot fix.
 *
 * This is not load balancing and must not become it. The supervisor's endpoint
 * intermittently answers with `{}` in sticky bursts — measured at eight of
 * thirteen affected calls returning it on all four attempts — so asking the
 * same endpoint again is close to worthless. Moving the retry elsewhere is the
 * only thing that addresses the failure actually observed.
 *
 * DeepInfra serves the same model, MiniMax M3, at the same price and the same
 * fp8 precision, so this changes where the work runs and not what runs. It is
 * listed separately from the primary allowlist precisely so that a request has
 * to ask for it: normal traffic still goes to one endpoint, and a fallback is
 * a decision rather than a coin toss.
 *
 * Zero-retention still applies. Every OpenRouter request already carries
 * `zdr: true` and `data_collection: "deny"`, which OpenRouter enforces per
 * endpoint, so an endpoint that stopped qualifying would be refused rather
 * than quietly used.
 */
const DEFAULT_FAILOVER_PROVIDERS = {
  // Not BaseTen or Morph: those carry the worker's normal traffic, and a
  // failover naming one is the same endpoint twice. Not DeepInfra or CoreWeave,
  // which serve GLM 5.3 Flash at fp4 and nvfp4 -- below the fp8 floor the
  // request itself demands, so every call routed there came back "No endpoints
  // found". Near AI and Inceptron are slower, and pass every rule.
  worker: ["near-ai", "inceptron"],
  // Parasail serves the supervisor's model compliantly but is held out of the
  // primary list for the same reason: kept in reserve, not in rotation.
  supervisor: ["parasail"],
} as const;

export function failoverProvidersFor(
  role: AiGenerationRole,
  env: NodeJS.ProcessEnv = process.env
): readonly string[] {
  if (role !== "worker" && role !== "supervisor") return [];
  return providerList(
    role === "worker"
      ? env.OPENROUTER_WORKER_FAILOVER_PROVIDERS
      : env.OPENROUTER_SUPERVISOR_FAILOVER_PROVIDERS,
    DEFAULT_FAILOVER_PROVIDERS[role]
  );
}

const QUALITY_QUANTIZATIONS = ["fp32", "fp16", "bf16", "fp8"] as const;
const JUROR_QUANTIZATIONS = [
  "fp32",
  "fp16",
  "bf16",
  "fp8",
  "int8",
  "int4",
] as const;

function envValue(
  env: Record<string, string | undefined>,
  key: string,
  fallback: string
) {
  return env[key]?.trim() || fallback;
}

function providerList(
  value: string | undefined,
  fallback: readonly string[]
) {
  const parsed = value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
  return parsed.length > 0 ? parsed : [...fallback];
}

export function buildAiCapabilityRegistry(
  env: Record<string, string | undefined>
): Readonly<Record<AiRole, AiCapability>> {
  return {
    worker: {
      role: "worker",
      provider: "openrouter",
      modelId: envValue(env, "OPENROUTER_WORKER_MODEL", DEFAULT_MODELS.worker),
      providerAllowlist: providerList(
        env.OPENROUTER_WORKER_PROVIDERS,
        DEFAULT_PROVIDERS.worker
      ),
      quantizations: QUALITY_QUANTIZATIONS,
      modalities: ["text", "image"],
      maxContextTokens: 1_048_576,
      maxOutputTokens: 16_384,
      reasoning: false,
    },
    supervisor: {
      role: "supervisor",
      provider: "openrouter",
      modelId: envValue(
        env,
        "OPENROUTER_SUPERVISOR_MODEL",
        DEFAULT_MODELS.supervisor
      ),
      providerAllowlist: providerList(
        env.OPENROUTER_SUPERVISOR_PROVIDERS,
        DEFAULT_PROVIDERS.supervisor
      ),
      quantizations: QUALITY_QUANTIZATIONS,
      modalities: ["text", "image"],
      maxContextTokens: 1_000_000,
      maxOutputTokens: 32_768,
      reasoning: true,
      standby: {
        modelId: envValue(
          env,
          "OPENROUTER_SUPERVISOR_STANDBY_MODEL",
          DEFAULT_STANDBY.supervisor.modelId
        ),
        providerAllowlist: providerList(
          env.OPENROUTER_SUPERVISOR_STANDBY_PROVIDERS,
          DEFAULT_STANDBY.supervisor.providerAllowlist
        ),
      },
    },
    juror: {
      role: "juror",
      provider: "openrouter",
      modelId: envValue(env, "OPENROUTER_JUROR_MODEL", DEFAULT_MODELS.juror),
      providerAllowlist: providerList(
        env.OPENROUTER_JUROR_PROVIDERS,
        DEFAULT_PROVIDERS.juror
      ),
      // Moonshot's first-party Kimi endpoint is currently INT4. The juror is
      // pinned to that endpoint by provider allowlist rather than inheriting
      // the FP8-or-better requirement used for the main worker/supervisor.
      quantizations: JUROR_QUANTIZATIONS,
      modalities: ["text", "image"],
      maxContextTokens: 262_144,
      maxOutputTokens: 16_384,
      reasoning: true,
    },
    research: {
      role: "research",
      provider: "gemini",
      modelId: envValue(env, "GEMINI_RESEARCH_MODEL", DEFAULT_MODELS.research),
      providerAllowlist: [],
      quantizations: [],
      modalities: ["text", "document"],
      maxContextTokens: 1_000_000,
      maxOutputTokens: 16_384,
      reasoning: false,
    },
    documentVision: {
      role: "documentVision",
      provider: "gemini",
      modelId: envValue(
        env,
        "GEMINI_DOCUMENT_MODEL",
        DEFAULT_MODELS.documentVision
      ),
      providerAllowlist: [],
      quantizations: [],
      modalities: ["text", "image", "document"],
      maxContextTokens: 1_000_000,
      maxOutputTokens: 16_384,
      reasoning: false,
    },
    tutorImage: {
      role: "tutorImage",
      provider: "gemini",
      modelId: envValue(env, "GEMINI_TUTOR_IMAGE_MODEL", DEFAULT_MODELS.tutorImage),
      providerAllowlist: [],
      quantizations: [],
      modalities: ["text", "image"],
      maxContextTokens: 65_536,
      maxOutputTokens: 8_192,
      reasoning: false,
    },
    paperImage: {
      role: "paperImage",
      provider: "gemini",
      modelId: envValue(env, "GEMINI_PAPER_IMAGE_MODEL", DEFAULT_MODELS.paperImage),
      providerAllowlist: [],
      quantizations: [],
      modalities: ["text", "image"],
      maxContextTokens: 65_536,
      maxOutputTokens: 8_192,
      reasoning: false,
    },
    embedding: {
      role: "embedding",
      provider: "gemini",
      modelId: DEFAULT_MODELS.embedding,
      providerAllowlist: [],
      quantizations: [],
      modalities: ["text", "image", "embedding"],
      maxContextTokens: 8_192,
      maxOutputTokens: 0,
      reasoning: false,
    },
  };
}

/**
 * Which requirements a provider does not currently meet, by variable name.
 *
 * A provider is ready only when its key is present *and* three separate
 * booleans are the literal string "true". Every AI route refuses with the same
 * "AI features are not configured" when none is ready, which is accurate and
 * says nothing about which of the eight possible reasons applied -- so a
 * deployment with a perfectly good `GEMINI_API_KEY` and no `GEMINI_ENABLED`
 * looks exactly like one with no key at all, and the obvious conclusion is that
 * the key is wrong.
 *
 * That is not hypothetical. Production ran with only `GEMINI_API_KEY` set, so
 * every AI feature in the app answered 503 and the Tutor told students it was
 * "not configured in this deployment yet", while the same code worked on any
 * machine with a full `.env.local`.
 *
 * Names only. A value is never returned from here -- the whole point is that
 * this is safe to log.
 */
export function describeUnmetAiProviderRequirements(
  env: Record<string, string | undefined>
): string[] {
  const unmet: string[] = [];

  for (const prefix of ["GEMINI", "OPENROUTER"] as const) {
    if (!env[`${prefix}_API_KEY`]?.trim()) unmet.push(`${prefix}_API_KEY`);
    for (const flag of [
      "ENABLED",
      "PRIVACY_APPROVED",
      "QUALITY_GATE_PASSED",
    ] as const) {
      if (env[`${prefix}_${flag}`] !== "true") {
        unmet.push(`${prefix}_${flag}`);
      }
    }
    if (env[`${prefix}_KILL_SWITCH`] === "true") {
      unmet.push(`${prefix}_KILL_SWITCH is on`);
    }
  }

  return unmet;
}

export function resolveAiProviderPolicy(
  env: Record<string, string | undefined>
): AiProviderPolicy {
  const openRouterReady = Boolean(
    env.OPENROUTER_API_KEY?.trim() &&
      env.OPENROUTER_ENABLED === "true" &&
      env.OPENROUTER_PRIVACY_APPROVED === "true" &&
      env.OPENROUTER_QUALITY_GATE_PASSED === "true" &&
      env.OPENROUTER_KILL_SWITCH !== "true"
  );
  const geminiReady = Boolean(
    env.GEMINI_API_KEY?.trim() &&
      env.GEMINI_ENABLED === "true" &&
      env.GEMINI_PRIVACY_APPROVED === "true" &&
      env.GEMINI_QUALITY_GATE_PASSED === "true" &&
      env.GEMINI_KILL_SWITCH !== "true"
  );
  return {
    openRouterReady,
    geminiReady,
    jurorReady: openRouterReady && env.OPENROUTER_JUROR_KILL_SWITCH !== "true",
    capabilities: buildAiCapabilityRegistry(env),
  };
}

export function decideTutorRoute(input: {
  message: string;
  sourceCount: number;
  repeatedConcept?: boolean;
  priorAnswerChallenged?: boolean;
  repeatedSupervisorChallenge?: boolean;
}): AiRouteDecision {
  if (input.repeatedSupervisorChallenge) {
    return { role: "juror", reason: "student_correction", taskClass: "important" };
  }
  if (input.repeatedConcept) {
    return { role: "supervisor", reason: "repeated_concept", taskClass: "important" };
  }
  const message = input.message.toLowerCase();
  if (
    input.priorAnswerChallenged ||
    /\b(that(?:'s| is) (?:wrong|incorrect)|you(?:'re| are) wrong|not correct|check again|recheck|you made (?:a|an) (?:mistake|error)|i disagree)\b/.test(message)
  ) {
    return { role: "supervisor", reason: "student_correction", taskClass: "important" };
  }
  if (input.sourceCount >= 8) {
    return { role: "supervisor", reason: "many_sources", taskClass: "important" };
  }
  if (message.length >= 1_200) {
    return { role: "supervisor", reason: "long_request", taskClass: "important" };
  }
  if (
    /\b(full solution|step[- ]by[- ]step|prove|proof|derive|evaluate|critique|mark my|assess my|compare and contrast|synthesi[sz]e|research question|dissertation|examiner)\b/.test(
      message
    )
  ) {
    return { role: "supervisor", reason: "complex_request", taskClass: "important" };
  }
  return { role: "worker", reason: "routine", taskClass: "standard" };
}

/** Compatibility wrapper for existing callers while they adopt route roles. */
export function classifyTutorTaskClass(input: {
  message: string;
  sourceCount: number;
}): AiTaskClass {
  return decideTutorRoute(input).taskClass;
}

export function hasVisualAiInput(contents: readonly {
  parts: readonly AiContentPart[];
}[]) {
  return contents.some((message) =>
    message.parts.some((part) => "inlineData" in part)
  );
}

function capabilityIsReady(role: AiGenerationRole, policy: AiProviderPolicy) {
  if (role === "juror") return policy.jurorReady;
  return policy.capabilities[role].provider === "openrouter"
    ? policy.openRouterReady
    : policy.geminiReady;
}

function attemptFor(
  role: AiGenerationRole,
  policy: AiProviderPolicy,
  routeReason: AiRouteReason
): AiProviderAttempt {
  const capability = policy.capabilities[role];
  return {
    provider: capability.provider,
    role,
    model: capability.modelId,
    providerAllowlist: capability.providerAllowlist,
    quantizations: capability.quantizations,
    thinking: capability.reasoning,
    reasoningEffort: getReasoningEffort(role),
    routeReason,
  };
}

function standbyAttemptFor(
  role: AiGenerationRole,
  policy: AiProviderPolicy
): AiProviderAttempt | null {
  const capability = policy.capabilities[role];
  const standby = capability.standby;
  // A standby is an alternative endpoint for the same role, so everything the
  // role guarantees — precision floor, reasoning, output cap — carries over
  // untouched. Only the model and the approved providers differ.
  if (!standby || !standby.modelId || standby.providerAllowlist.length === 0) {
    return null;
  }
  if (standby.modelId === capability.modelId) return null;
  return {
    provider: capability.provider,
    role,
    model: standby.modelId,
    providerAllowlist: standby.providerAllowlist,
    quantizations: capability.quantizations,
    thinking: capability.reasoning,
    reasoningEffort: getReasoningEffort(role),
    routeReason: "provider_standby",
  };
}

/**
 * The same model on the second endpoint its role already approves.
 *
 * The failover list existed to answer a specific fault -- an endpoint
 * returning `{}` in sticky bursts -- and was reachable only by a caller that
 * had already parsed a reply and found it empty. An endpoint that is simply
 * *gone* never gets that far: it throws, and the plan went straight past the
 * same model on a healthy host to a different model entirely.
 *
 * That is what an outage looks like from here. MiniMax M3 on its primary
 * endpoint returned 502 in under half a second on every call, so every marking
 * fell to the Kimi K3 standby at once and was rate-limited there, while the
 * same MiniMax M3 on DeepInfra answered in 1.4 seconds throughout.
 *
 * Ordered before the standby deliberately: the same model elsewhere is a
 * smaller change than a different model, and precision, price and zero
 * retention all carry over untouched.
 */
function failoverAttemptFor(
  role: AiGenerationRole,
  policy: AiProviderPolicy,
  env: NodeJS.ProcessEnv = process.env
): AiProviderAttempt | null {
  const providers = failoverProvidersFor(role, env);
  if (providers.length === 0) return null;
  const capability = policy.capabilities[role];
  return {
    provider: capability.provider,
    role,
    model: capability.modelId,
    providerAllowlist: providers,
    quantizations: capability.quantizations,
    thinking: capability.reasoning,
    reasoningEffort: getReasoningEffort(role),
    routeReason: "provider_failover",
  };
}

export function buildAiProviderPlan(input: {
  role?: AiGenerationRole;
  taskClass?: AiTaskClass;
  routeReason?: AiRouteReason;
  hasVisualInput: boolean;
  policy: AiProviderPolicy;
  /**
   * Whether a worker call may finish on the supervisor.
   *
   * Defaults to true, which is what every existing caller expects. A route
   * whose job is bulk and cheap passes false: escalating a batch of a hundred
   * cards to the expensive model would turn a routine preparation run into a
   * bill nobody asked for, and a worker that cannot do the job should say so
   * rather than quietly buy a better one.
   */
  allowRoleEscalation?: boolean;
  /**
   * Try the supervisor's standby before its primary. For a live Tutor answer,
   * where the standby (Kimi K3) gave its first words in about a second and the
   * primary (Qwen) took fifteen to a hundred; papers and marking keep the order.
   */
  preferStandby?: boolean;
}): AiProviderAttempt[] {
  let role: AiGenerationRole;
  let reason: AiRouteReason;
  if (input.role) {
    role = input.role;
    reason = input.routeReason ?? "explicit_role";
  } else if (input.taskClass === "visual") {
    role = "documentVision";
    reason = "visual_specialist";
  } else {
    role = input.taskClass === "important" ? "supervisor" : "worker";
    reason = input.taskClass === "important" ? "complex_request" : "routine";
  }

  if (!capabilityIsReady(role, input.policy)) return [];
  const primary = attemptFor(role, input.policy, reason);
  const attempts = [primary, { ...primary }];
  if (role === "worker") {
    const failover = failoverAttemptFor(role, input.policy);
    if (failover) attempts.push(failover);
    if (
      input.allowRoleEscalation !== false &&
      capabilityIsReady("supervisor", input.policy)
    ) {
      attempts.push(attemptFor("supervisor", input.policy, "provider_escalation"));
    }
    return attempts;
  }
  const failover = failoverAttemptFor(role, input.policy);
  const standby = standbyAttemptFor(role, input.policy);
  if (input.preferStandby && standby) {
    // The primary stays as the fallback, once: a second try at the slow model would outlast the answer's deadline.
    return [standby, primary, ...(failover ? [failover] : [])];
  }
  if (failover) attempts.push(failover);
  if (standby) attempts.push(standby);
  return attempts;
}
