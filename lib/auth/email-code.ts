/**
 * The rules for the six-digit codes Jami emails at sign-up, with no I/O.
 *
 * A code proves somebody can read the inbox they typed. It is what stands
 * between an email address and an account: a new account is only created once
 * one has been entered.
 */

export const EMAIL_CODE_LENGTH = 6;

/** Long enough to switch apps and find the mail; short enough to be useless when leaked. */
export const EMAIL_CODE_TTL_MS = 10 * 60_000;

/**
 * Wrong guesses allowed against one code before it is thrown away.
 *
 * Five in a million is not a meaningful chance, and a fresh code has to be
 * asked for -- which is itself limited below -- so guessing cannot be scaled up.
 */
export const EMAIL_CODE_MAX_ATTEMPTS = 5;

/** The gap enforced between two codes to the same address. */
export const EMAIL_CODE_RESEND_COOLDOWN_MS = 60_000;

/**
 * Codes to one address in an hour. Enough for somebody whose mail is slow,
 * nowhere near enough to use Jami to flood a stranger's inbox.
 */
export const EMAIL_CODE_MAX_SENDS_PER_HOUR = 5;

/** Codes from one network address in an hour, whichever inboxes they go to. */
export const EMAIL_CODE_MAX_SENDS_PER_SENDER_PER_HOUR = 20;

const HOUR_MS = 60 * 60_000;

/**
 * Whether an account's email lets it use Jami's AI.
 *
 * Every account Jami's sign-up makes is confirmed, and Google confirms its own,
 * so the only unconfirmed accounts are the ones from before sign-up asked for a
 * code -- which are fine, and are never asked to confirm now -- and ones made
 * by going around the form straight to Firebase with the app's public config.
 * Those are what a script would make by the hundred for a fresh daily AI
 * allowance each, so they get none.
 *
 * `confirmationRequiredFrom` is when this started: an unconfirmed account made
 * before it is an existing student. Until it is known, nobody is refused.
 */
export function accountMayUseAi(
  account: {
    email: string | null | undefined;
    emailVerified: boolean;
    providerIds: readonly string[];
    /** When the account was created, in ms; null if Firebase did not say. */
    createdAt: number | null;
  },
  confirmationRequiredFrom: number | null
) {
  const unconfirmedPasswordAccount =
    Boolean(account.email) &&
    !account.emailVerified &&
    account.providerIds.includes("password");
  if (!unconfirmedPasswordAccount) return true;
  if (confirmationRequiredFrom === null || account.createdAt === null) return true;
  return account.createdAt < confirmationRequiredFrom;
}

/** Addresses are compared case-insensitively, as every mail provider treats them. */
export function normaliseEmail(email: string) {
  return email.trim().toLowerCase();
}

/**
 * A deliberately loose check: one @, something either side, a dot in the
 * domain, no spaces. Anything stricter refuses real addresses; the code is the
 * real test of whether the address works.
 */
export function isPlausibleEmail(email: string) {
  const normalised = normaliseEmail(email);
  return (
    normalised.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalised)
  );
}

/** Digits only, at most six: what the code field keeps from whatever was typed or pasted. */
export function sanitiseEmailCodeInput(raw: string) {
  return raw.replace(/\D/g, "").slice(0, EMAIL_CODE_LENGTH);
}

export function isCompleteEmailCode(code: string) {
  return new RegExp(`^\\d{${EMAIL_CODE_LENGTH}}$`).test(code);
}

/** What is remembered about the codes sent to one address for one purpose. */
export type EmailCodeSendHistory = {
  lastSentAt: number | null;
  /** When the current hour of counting began. */
  windowStartedAt: number | null;
  sendsInWindow: number;
};

export type EmailCodeSendDecision =
  | { allowed: true; windowStartedAt: number; sendsInWindow: number }
  | { allowed: false; retryAfterSeconds: number };

function secondsUntil(target: number, now: number) {
  return Math.max(1, Math.ceil((target - now) / 1000));
}

/**
 * Whether another code may go out now, and the counters to store if so.
 *
 * `limit` is the hourly allowance for whatever is being counted -- one address,
 * or one sender.
 */
export function decideEmailCodeSend(
  history: EmailCodeSendHistory,
  now: number,
  limit: number,
  cooldownMs = EMAIL_CODE_RESEND_COOLDOWN_MS
): EmailCodeSendDecision {
  if (
    cooldownMs > 0 &&
    history.lastSentAt !== null &&
    now - history.lastSentAt < cooldownMs
  ) {
    return {
      allowed: false,
      retryAfterSeconds: secondsUntil(history.lastSentAt + cooldownMs, now),
    };
  }

  const windowIsCurrent =
    history.windowStartedAt !== null && now - history.windowStartedAt < HOUR_MS;
  const windowStartedAt = windowIsCurrent ? history.windowStartedAt! : now;
  const sendsInWindow = windowIsCurrent ? history.sendsInWindow : 0;

  if (sendsInWindow >= limit) {
    return {
      allowed: false,
      retryAfterSeconds: secondsUntil(windowStartedAt + HOUR_MS, now),
    };
  }

  return { allowed: true, windowStartedAt, sendsInWindow: sendsInWindow + 1 };
}

/** "Wait 45 seconds" / "Wait 12 minutes", for a code or email asked for too soon. */
export function describeEmailCodeWait(retryAfterSeconds: number, thing = "code") {
  const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
  if (seconds < 90) {
    return `Wait ${seconds} ${seconds === 1 ? "second" : "seconds"} before asking for another ${thing}.`;
  }
  return `Wait ${Math.ceil(seconds / 60)} minutes before asking for another ${thing}.`;
}

/** The live code for an address, as stored: never the code itself. */
export type StoredEmailCode = {
  codeHash: string;
  salt: string;
  expiresAt: number;
  attempts: number;
};

export type EmailCodeCheck =
  | { usable: true }
  | { usable: false; reason: "missing" | "expired" | "exhausted" };

/** Whether a stored code can still be tried at all, before comparing anything. */
export function checkStoredEmailCode(
  stored: StoredEmailCode | null,
  now: number
): EmailCodeCheck {
  if (!stored) return { usable: false, reason: "missing" };
  if (now >= stored.expiresAt) return { usable: false, reason: "expired" };
  if (stored.attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
    return { usable: false, reason: "exhausted" };
  }
  return { usable: true };
}

export type EmailCodeFailure =
  | "missing"
  | "expired"
  | "exhausted"
  | "mismatch";

/** What to tell somebody whose code was not accepted. */
export function describeEmailCodeFailure(
  failure: EmailCodeFailure,
  attemptsLeft = 0
): string {
  switch (failure) {
    case "missing":
      return "Ask for a code first, then enter it here.";
    case "expired":
      return "That code has expired. Send a new one and use that instead.";
    case "exhausted":
      return "Too many wrong tries for that code. Send a new one to carry on.";
    case "mismatch":
      return attemptsLeft > 0
        ? `That code isn't right. Check the email and try again (${attemptsLeft} ${
            attemptsLeft === 1 ? "try" : "tries"
          } left).`
        : "That code isn't right, and it can't be tried again. Send a new one.";
  }
}
