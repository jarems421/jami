import { auth } from "../firebase/client";
import {
  EmailAuthProvider,
  GoogleAuthProvider,
  applyActionCode,
  browserLocalPersistence,
  confirmPasswordReset,
  getRedirectResult,
  verifyPasswordResetCode,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
} from "firebase/auth";
import {
  ACCOUNT_DELETION_CONFIRMATION,
  type AccountDeletionErrorCode,
  type AccountDeletionPhase,
} from "@/lib/auth/account-deletion-contract";
import { getAuthErrorCode, getFriendlyAuthError } from "@/lib/auth/errors";
import { getPasswordRequirementMessage } from "@/lib/auth/password-strength";
import { writePhotoBackground } from "@/lib/app/photo-background";
import { applyAppearanceToDevice, DEFAULT_APPEARANCE } from "@/lib/app/appearance";
import { clearDeviceCopies } from "@/services/cache/device-store";
import { clearStoredStudyActions } from "@/services/learning/study-actions";
import { clearStoredTodayRevisionPlans } from "@/services/planning/revision-plans";

const provider = new GoogleAuthProvider();
const AUTH_OPERATION_TIMEOUT_MS = 30_000;

export function shouldFallbackToGoogleRedirect(code: string | undefined) {
  return (
    code === "auth/popup-blocked" ||
    code === "auth/operation-not-supported-in-this-environment"
  );
}

function withAuthTimeout<T>(operation: Promise<T>, timeoutMs = AUTH_OPERATION_TIMEOUT_MS) {
  return new Promise<T>((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      reject(Object.assign(new Error("Sign-in timed out."), {
        code: "auth/timeout",
      }));
    }, timeoutMs);

    operation.then(
      (value) => {
        globalThis.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        globalThis.clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

function isStandaloneAppWindow() {
  if (typeof window === "undefined") return false;
  const navigatorWithStandalone = window.navigator as Navigator & {
    standalone?: boolean;
  };
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    navigatorWithStandalone.standalone === true
  );
}

export function createRetryableInitializer(initialize: () => Promise<void>) {
  let initializationPromise: Promise<void> | null = null;

  return async () => {
    if (!initializationPromise) {
      initializationPromise = initialize();
    }

    try {
      await initializationPromise;
    } catch (error) {
      // Allow retries after transient/local-storage failures.
      initializationPromise = null;
      throw error;
    }
  };
}

const ensureAuthInitialized = createRetryableInitializer(() =>
  setPersistence(auth, browserLocalPersistence)
);

// Ensure session persists
export const initAuth = async () => {
  await ensureAuthInitialized();
};

// Google sign-in — use the popup flow everywhere. Redirect auth relies on
// cross-origin helper storage unless it is proxied through the app's origin,
// which is not available in the installed PWA.
export const signInWithGoogle = async () => {
  await initAuth();
  const standalone = isStandaloneAppWindow();
  try {
    const result = await withAuthTimeout(signInWithPopup(auth, provider));
    return result.user;
  } catch (popupError: unknown) {
    const code = (popupError as { code?: string }).code;
    // Redirect only when the browser cannot open a popup. User cancellation
    // should return control to the current page instead of starting a redirect.
    if (!standalone && shouldFallbackToGoogleRedirect(code)) {
      await signInWithRedirect(auth, provider);
      return null; // page will reload via redirect
    }
    throw popupError;
  }
};

// Handle redirect result on page load
export const handleGoogleRedirectResult = async () => {
  await initAuth();
  const result = await getRedirectResult(auth);
  return result?.user ?? null;
};

// Logout
export const logout = async () => {
  await signOut(auth);
  // The photo background and the look are this account's. On a shared device
  // the next person to sign in should not open on them.
  writePhotoBackground(null);
  applyAppearanceToDevice(DEFAULT_APPEARANCE, null);
  forgetDeviceCopies();
};

/**
 * The copies of Today kept for a fast launch are this account's too, and say
 * far more about it than its colours do.
 */
function forgetDeviceCopies() {
  void clearDeviceCopies();
  clearStoredStudyActions();
  clearStoredTodayRevisionPlans();
}

// Email sign-up
/**
 * Thrown when a password is refused before an account is ever created.
 *
 * Carries a `code` so it travels the same path as a Firebase error, and its
 * message is already the sentence to show -- it explains one specific problem,
 * which no generic mapping could.
 */
export class WeakPasswordError extends Error {
  readonly code = "jami/weak-password";
  constructor(message: string) {
    super(message);
    this.name = "WeakPasswordError";
  }
}

/**
 * A refusal from one of Jami's own account routes.
 *
 * Its message is already the sentence to show -- the server knows which of a
 * dozen things went wrong with a code or an address, and a generic mapping
 * would lose that.
 */
export class AuthRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "AuthRequestError";
  }
}

async function postAuthRoute(
  path: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(AUTH_OPERATION_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = (error as { name?: string })?.name === "TimeoutError";
    throw new AuthRequestError(
      timedOut ? "auth/timeout" : "auth/network-request-failed",
      timedOut
        ? "That took too long. Check your connection and try again."
        : "Jami could not reach the sign-in service. Check your connection and try again."
    );
  }

  const result = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;

  if (!response.ok) {
    throw new AuthRequestError(
      typeof result?.code === "string" ? result.code : "auth/unknown",
      typeof result?.error === "string" && result.error.trim()
        ? result.error
        : "That did not work. Please try again.",
      typeof result?.retryAfterSeconds === "number"
        ? result.retryAfterSeconds
        : undefined
    );
  }

  return result ?? {};
}

/**
 * The sentence to show for anything thrown while signing in or up: Jami's own
 * refusals already carry one, and Firebase's codes are mapped to one.
 */
export function getAuthErrorMessage(error: unknown) {
  if (error instanceof AuthRequestError || error instanceof WeakPasswordError) {
    return error.message;
  }
  return getFriendlyAuthError(getAuthErrorCode(error));
}

function readResendAfterSeconds(result: Record<string, unknown>) {
  return typeof result.resendAfterSeconds === "number"
    ? result.resendAfterSeconds
    : 60;
}

/**
 * Emails a sign-up code: the first half of creating an email account.
 *
 * Nothing is created yet. The account only exists once the code comes back,
 * which is what makes an address somebody cannot read useless for signing up.
 */
export const requestSignUpCode = async (email: string) => {
  const result = await postAuthRoute("/api/auth/sign-up/code", { email });
  return { resendAfterSeconds: readResendAfterSeconds(result) };
};

/**
 * Creates the account with the emailed code, then signs straight in.
 *
 * Jami's server creates it, already confirmed, after checking the code and
 * the password -- the password check here only answers faster than a round
 * trip would.
 */
export const createAccountWithCode = async (
  email: string,
  password: string,
  code: string
) => {
  const problem = getPasswordRequirementMessage(password, email);
  if (problem) throw new WeakPasswordError(problem);

  await postAuthRoute("/api/auth/sign-up", { email, password, code });
  try {
    return await signInWithEmail(email, password);
  } catch {
    // The account exists by now; only the sign-in after it did not happen.
    // Saying sign-up failed would send them round for a new code they no
    // longer need.
    throw new AuthRequestError(
      "auth/created-not-signed-in",
      "Your account is ready. Sign in with your email and password to continue."
    );
  }
};

/** Whose address a reset link belongs to, and whether it is still good. */
export const checkPasswordResetCode = async (code: string) => {
  await initAuth();
  return withAuthTimeout(verifyPasswordResetCode(auth, code));
};

/**
 * Completes a password reset against Jami's policy rather than Firebase's.
 *
 * This is the whole reason the reset form lives in the app. Firebase's hosted
 * action page enforces its own six-character floor and nothing else, so a
 * password refused at sign-up could be set through the emailed link minutes
 * later. Routed here, the same rule applies to both.
 */
export const completePasswordReset = async (code: string, password: string) => {
  await initAuth();
  const email = await withAuthTimeout(verifyPasswordResetCode(auth, code));
  const problem = getPasswordRequirementMessage(password, email);
  if (problem) throw new WeakPasswordError(problem);
  await withAuthTimeout(confirmPasswordReset(auth, code, password));
  return email;
};

/** Applies a verify-email or similar one-time code. */
export const applyAuthActionCode = async (code: string) => {
  await initAuth();
  await withAuthTimeout(applyActionCode(auth, code));
};

// Email sign-in
export const signInWithEmail = async (email: string, password: string) => {
  await initAuth();
  const result = await withAuthTimeout(
    signInWithEmailAndPassword(auth, email, password)
  );
  return result.user;
};

/**
 * Asks Jami to email a reset link. Jami's server sends it from jami.study
 * rather than leaving it to Firebase's mailer, whose generic sender and
 * signature ended up in junk folders.
 */
export const sendPasswordReset = async (email: string) => {
  await postAuthRoute("/api/auth/password-reset", { email: email.trim() });
};

export class AccountDeletionError extends Error {
  code: AccountDeletionErrorCode;

  constructor(code: AccountDeletionErrorCode, message: string) {
    super(message);
    this.name = "AccountDeletionError";
    this.code = code;
  }
}

export function getAccountDeletionErrorCode(error: unknown) {
  return error instanceof AccountDeletionError ? error.code : undefined;
}

export async function reauthenticateForAccountDeletion(password?: string) {
  await initAuth();
  const user = auth.currentUser;
  if (!user) {
    throw new AccountDeletionError(
      "auth/unauthorized",
      "Sign in again before deleting your account."
    );
  }

  const providerIds = new Set(
    user.providerData.map((providerData) => providerData.providerId)
  );

  if (providerIds.has("google.com")) {
    await withAuthTimeout(reauthenticateWithPopup(user, provider));
    return;
  }

  if (providerIds.has("password")) {
    if (!user.email || !password) {
      throw new AccountDeletionError(
        "account/password-required",
        "Enter your current password to continue."
      );
    }
    const credential = EmailAuthProvider.credential(user.email, password);
    await withAuthTimeout(reauthenticateWithCredential(user, credential));
    return;
  }

  throw new AccountDeletionError(
    "account/unsupported-provider",
    "Sign out, sign back in, and then try deleting your account again."
  );
}

export async function deleteAccount(
  onPhaseChange?: (phase: AccountDeletionPhase) => void
) {
  await initAuth();
  const user = auth.currentUser;
  if (!user) {
    throw new AccountDeletionError(
      "auth/unauthorized",
      "Sign in again before deleting your account."
    );
  }

  onPhaseChange?.("authorizing");
  const token = await user.getIdToken(true);
  onPhaseChange?.("deleting");

  const response = await fetch("/api/account/delete", {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ confirmation: ACCOUNT_DELETION_CONFIRMATION }),
  });

  // Error responses are not guaranteed to contain JSON; status still drives a
  // stable fallback message below.
  const result = (await response.json().catch(() => null)) as
    | { error?: unknown; code?: unknown }
    | null;

  if (!response.ok) {
    const code =
      result?.code === "auth/requires-recent-login" ||
      result?.code === "auth/unauthorized" ||
      result?.code === "account/deletion-incomplete"
        ? result.code
        : "account/deletion-incomplete";
    const message =
      typeof result?.error === "string" && result.error.trim()
        ? result.error
        : "Jami could not finish deleting your account. Try again.";
    throw new AccountDeletionError(code, message);
  }

  await signOut(auth).catch(() => {
    // The server has already deleted the account; local auth cleanup is best-effort.
  });
  writePhotoBackground(null);
  forgetDeviceCopies();
}
