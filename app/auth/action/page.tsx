"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  applyAuthActionCode,
  checkPasswordResetCode,
  completePasswordReset,
} from "@/services/auth";
import { getAuthErrorCode } from "@/lib/auth/errors";
import {
  getAuthActionCopy,
  getAuthActionErrorMessage,
  parseAuthActionRequest,
  type AuthActionMode,
} from "@/lib/auth/auth-action";
import {
  assessPassword,
  getPasswordRequirementMessage,
  PASSWORD_MINIMUM_LENGTH,
} from "@/lib/auth/password-strength";
import AuthShell from "@/components/auth/AuthShell";
import PasswordField from "@/components/auth/PasswordField";
import PasswordStrength from "@/components/auth/PasswordStrength";
import { Button } from "@/components/ui";

type Status = "checking" | "ready" | "working" | "done" | "failed";

const PASSWORD_MISMATCH_MESSAGE =
  "The two passwords don't match. Type the same new password in both boxes.";

/**
 * The badge at the top of the card: a spinner while the link is checked, a
 * key while a new password is wanted, and a tick or a warning once it is over.
 */
function StatusBadge({ status }: { status: Status }) {
  const tone =
    status === "done"
      ? "text-[var(--color-success-mark)]"
      : status === "failed"
        ? "text-[var(--color-error-mark)]"
        : "text-text-primary";

  return (
    <div
      className={`grid h-14 w-14 place-items-center rounded-full border border-[var(--color-border-strong)] bg-[var(--color-glass-medium)] shadow-e1 ${tone}`}
      aria-hidden="true"
    >
      {status === "checking" ? (
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--color-border-strong)] border-t-[var(--color-text-primary)] motion-reduce:animate-none" />
      ) : (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-6 w-6"
        >
          {status === "done" ? (
            <path d="m5 12.5 4.5 4.5L19 7.5" />
          ) : status === "failed" ? (
            <>
              <path d="M12 8v5" />
              <path d="M12 16.5h.01" />
              <circle cx="12" cy="12" r="9" />
            </>
          ) : (
            <>
              <circle cx="8" cy="15" r="4" />
              <path d="m10.8 12.2 8.2-8.2" />
              <path d="m16 7 2.5 2.5" />
              <path d="m13.5 9.5 2 2" />
            </>
          )}
        </svg>
      )}
    </div>
  );
}

function AuthActionContent() {
  const router = useRouter();
  const params = useSearchParams();
  const { mode, code } = parseAuthActionRequest(params);
  const copy = getAuthActionCopy(mode);

  // A link with no code, or a mode Jami does not handle, is already decided --
  // there is nothing to go and ask Firebase. Starting there rather than
  // correcting it from an effect avoids a render that only exists to fail.
  //
  // A known mode with no code is a link that lost its end on the way, which is
  // what Firebase's own "invalid code" message already says. Showing the mode's
  // instructions instead put "pick a password" in an error box.
  const unusable = !code || mode === "unknown";
  const [status, setStatus] = useState<Status>(unusable ? "failed" : "checking");
  const [message, setMessage] = useState<string | null>(
    unusable
      ? mode === "unknown"
        ? copy.description
        : getAuthActionErrorMessage("auth/invalid-action-code")
      : null
  );
  const [accountEmail, setAccountEmail] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const startedRef = useRef(false);

  useEffect(() => {
    // One-time codes are spent when used, so a second run in development's
    // double-invoked effects would report the first success as a failure.
    if (startedRef.current || unusable || !code) return;
    startedRef.current = true;

    if (mode === "resetPassword") {
      void checkPasswordResetCode(code)
        .then((email) => {
          setAccountEmail(email);
          setStatus("ready");
        })
        .catch((error) => {
          setStatus("failed");
          setMessage(getAuthActionErrorMessage(getAuthErrorCode(error)));
        });
      return;
    }

    void applyAuthActionCode(code)
      .then(() => {
        setStatus("done");
        setMessage(
          mode === "verifyEmail"
            ? "Your email is confirmed. That is the address a reset link will go to."
            : "Your email address has been restored. Change your password too if you did not expect this."
        );
      })
      .catch((error) => {
        setStatus("failed");
        setMessage(getAuthActionErrorMessage(getAuthErrorCode(error)));
      });
  }, [code, mode, unusable]);

  const submitNewPassword = useCallback(async () => {
    if (!code) return;
    const problem = getPasswordRequirementMessage(password, accountEmail ?? "");
    if (problem) {
      setMessage(problem);
      return;
    }
    // Typed blind, a slip here locks the student out with a password they
    // never meant -- so it is typed twice, and nothing is sent until they agree.
    if (password !== confirmation) {
      setMessage(PASSWORD_MISMATCH_MESSAGE);
      return;
    }

    setStatus("working");
    setMessage(null);
    try {
      await completePasswordReset(code, password);
      setStatus("done");
      setMessage("Your password is changed. Sign in with it now.");
    } catch (error) {
      setStatus("ready");
      const weak = (error as { code?: string })?.code === "jami/weak-password";
      setMessage(
        weak
          ? (error as Error).message
          : getAuthActionErrorMessage(getAuthErrorCode(error))
      );
    }
  }, [accountEmail, code, confirmation, password]);

  const assessment = assessPassword(password, accountEmail ?? "");
  // Said as soon as the second box is as long as the first, not on every key.
  const visiblyMismatched =
    confirmation.length >= password.length && confirmation.length > 0 && confirmation !== password;
  const showResetForm = mode === "resetPassword" && (status === "ready" || status === "working");

  return (
    <AuthShell back={{ href: "/auth", label: "Sign in" }}>
      <div className="flex flex-col items-center text-center">
        <StatusBadge status={status} />
        <h1 className="mt-5 text-2xl font-semibold tracking-tight text-text-primary">
          {status === "done"
            ? "All done"
            : status === "failed"
              ? getAuthActionCopy("unknown").title
              : copy.title}
        </h1>
        {accountEmail && showResetForm ? (
          <p className="mt-1.5 text-sm text-text-secondary">
            For <span className="font-medium text-text-primary">{accountEmail}</span>
          </p>
        ) : null}
        {status === "checking" ? (
          <p className="mt-1.5 text-sm leading-6 text-text-secondary" role="status">
            Checking your link...
          </p>
        ) : null}
      </div>

      {showResetForm ? (
        <form
          className="mt-6 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submitNewPassword();
          }}
        >
          <p className="text-center text-sm leading-6 text-text-secondary">
            {copy.description}
          </p>
          <div>
            <PasswordField
              label="New password"
              placeholder={`At least ${PASSWORD_MINIMUM_LENGTH} characters`}
              value={password}
              autoComplete="new-password"
              onChange={(event) => {
                setPassword(event.target.value);
                setMessage(null);
              }}
            />
            {password ? <PasswordStrength assessment={assessment} /> : null}
          </div>
          <div>
            <PasswordField
              label="Confirm new password"
              placeholder="Type it again"
              value={confirmation}
              autoComplete="new-password"
              aria-invalid={visiblyMismatched || undefined}
              aria-describedby={visiblyMismatched ? "password-mismatch" : undefined}
              onChange={(event) => {
                setConfirmation(event.target.value);
                setMessage(null);
              }}
            />
            {visiblyMismatched ? (
              <p id="password-mismatch" className="mt-2 text-xs text-[var(--color-error-mark)]">
                These don&apos;t match yet.
              </p>
            ) : null}
          </div>
          <Button
            type="submit"
            variant="primary"
            size="lg"
            className="!mt-6 w-full justify-center"
            disabled={status === "working"}
          >
            {status === "working" ? "Changing password..." : "Change password"}
          </Button>
        </form>
      ) : null}

      {message ? (
        <p
          role={status === "failed" ? "alert" : "status"}
          className={`mt-5 rounded-lg px-4 py-3 text-sm leading-6 ${
            status === "failed" ? "app-danger" : "app-success"
          }`}
        >
          {message}
        </p>
      ) : null}

      {status === "done" || status === "failed" ? (
        <Button
          type="button"
          variant={status === "done" ? "primary" : "secondary"}
          size="lg"
          className="mt-5 w-full justify-center"
          onClick={() => router.replace("/auth")}
        >
          Go to sign in
        </Button>
      ) : null}
    </AuthShell>
  );
}

/**
 * `useSearchParams` opts a route into client rendering, and Next requires the
 * boundary to be explicit rather than inferred.
 */
export default function AuthActionPage() {
  return (
    <Suspense fallback={null}>
      <AuthActionContent />
    </Suspense>
  );
}

export type { AuthActionMode };
