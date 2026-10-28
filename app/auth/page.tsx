"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getAuthErrorMessage,
  handleGoogleRedirectResult,
  requestSignUpCode,
  signInWithEmail,
  signInWithGoogle,
  sendPasswordReset,
} from "@/services/auth";
import { listenToAuth } from "@/services/auth/auth-listener";
import { getAuthErrorCode, getFriendlyAuthError } from "@/lib/auth/errors";
import { suggestEmailCorrection } from "@/lib/auth/email-typos";
import {
  assessPassword,
  getPasswordRequirementMessage,
  PASSWORD_MINIMUM_LENGTH,
} from "@/lib/auth/password-strength";
import AuthShell from "@/components/auth/AuthShell";
import GoogleMark from "@/components/auth/GoogleMark";
import PasswordField from "@/components/auth/PasswordField";
import PasswordStrength from "@/components/auth/PasswordStrength";
import SignUpCodeStep from "@/components/auth/SignUpCodeStep";
import { BrandMark, Button, Input } from "@/components/ui";

const AUTH_MODES = [
  { signIn: true, label: "Sign in" },
  { signIn: false, label: "Create account" },
] as const;

export default function AuthPage() {
  const router = useRouter();
  const routerRef = useRef(router);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSignInMode, setIsSignInMode] = useState(true);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * Set once a sign-up code has been sent, which moves the create tab on to
   * asking for it. Nothing has been created at that point.
   */
  const [codeStep, setCodeStep] = useState<{ resendAfterSeconds: number } | null>(
    null
  );
  /** The typo hint waits for the field to be left, not the first keystroke. */
  const [emailTouched, setEmailTouched] = useState(false);

  useEffect(() => {
    routerRef.current = router;
  }, [router]);

  useEffect(() => {
    const unsubscribe = listenToAuth((user) => {
      if (user) {
        routerRef.current.replace("/dashboard");
      }
    });

    void handleGoogleRedirectResult()
      .then((user) => {
        if (user) {
          routerRef.current.replace("/dashboard");
        } else {
          setGoogleLoading(false);
        }
      })
      .catch((nextError) => {
        const code = getAuthErrorCode(nextError);
        setError(getFriendlyAuthError(code));
        setGoogleLoading(false);
        console.error("Google redirect sign-in failed.", {
          code: code ?? "unknown",
        });
      });

    return () => unsubscribe();
  }, []);

  const handleSubmit = async () => {
    const trimmedEmail = email.trim();

    if (!trimmedEmail || !password) {
      setError("Enter your email and password.");
      return;
    }

    // Only on the way in. Holding an existing password to a policy it predates
    // would lock people out of their own accounts over a rule they never
    // agreed to; the reset link is how an old password gets replaced.
    if (!isSignInMode) {
      const problem = getPasswordRequirementMessage(password, trimmedEmail);
      if (problem) {
        setError(problem);
        return;
      }
    }

    setLoading(true);
    setError(null);

    try {
      if (isSignInMode) {
        await signInWithEmail(trimmedEmail, password);
      } else {
        // Only a code is sent here. The account is created by the next step,
        // once the code proves the inbox is real and theirs.
        const sent = await requestSignUpCode(trimmedEmail);
        setCodeStep({ resendAfterSeconds: sent.resendAfterSeconds });
      }
    } catch (nextError) {
      setError(getAuthErrorMessage(nextError));
    } finally {
      setLoading(false);
    }
  };

  const passwordAssessment = assessPassword(password, email);
  const passwordProblem = getPasswordRequirementMessage(password, email);

  const selectMode = (signIn: boolean) => {
    setIsSignInMode(signIn);
    setCodeStep(null);
    setError(null);
    setNotice(null);
  };

  const emailSuggestion =
    !isSignInMode && emailTouched ? suggestEmailCorrection(email) : null;
  const awaitingCode = !isSignInMode && codeStep !== null;

  const handleGoogleSignIn = async () => {
    if (googleLoading) return;
    setGoogleLoading(true);
    setError(null);
    try {
      const user = await signInWithGoogle();
      if (user) {
        routerRef.current.replace("/dashboard");
      }
    } catch (nextError) {
      const code = getAuthErrorCode(nextError);
      setError(getFriendlyAuthError(code));
      setGoogleLoading(false);
    }
  };

  const handlePasswordReset = async () => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setError("Enter your email first, then choose Forgot password.");
      setNotice(null);
      return;
    }

    setResetLoading(true);
    setError(null);
    setNotice(null);
    try {
      await sendPasswordReset(trimmedEmail);
      setNotice(
        "If an account exists for that email, a link to reset its password is on its way. It comes from noreply@jami.study; check junk if it hasn't arrived in a minute."
      );
    } catch (nextError) {
      setError(getAuthErrorMessage(nextError));
    } finally {
      setResetLoading(false);
    }
  };

  const busy = loading || googleLoading || resetLoading;

  return (
    <AuthShell footnote="Your decks, notebooks and progress sync across all your devices.">
      <div className="flex flex-col items-center text-center">
        <div className="login-brand-halo [--brand-halo-size:3.25rem]" aria-hidden="true">
          <span className="login-brand-spark login-brand-spark-one" />
          <span className="login-brand-spark login-brand-spark-two" />
          <span className="login-brand-spark login-brand-spark-three" />
          <BrandMark size="lg" />
        </div>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight text-text-primary">
          {isSignInMode
            ? "Welcome back"
            : awaitingCode
              ? "Check your inbox"
              : "Create your account"}
        </h1>
        <p className="mt-1.5 text-sm leading-6 text-text-secondary">
          {isSignInMode
            ? "Sign in to pick up where you left off."
            : awaitingCode
              ? "Enter the code we emailed you to finish."
              : "We'll email you a code to confirm it's really you."}
        </p>
      </div>

      {/*
        * Tabs rather than a pair of buttons: "Sign in" as a button here would
        * be a second match for the submit button of the same name.
        */}
      <div
        role="tablist"
        aria-label="Account"
        className="mt-7 grid grid-cols-2 gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-glass-subtle)] p-1"
      >
        {AUTH_MODES.map((mode) => {
          const selected = mode.signIn === isSignInMode;
          return (
            <button
              key={mode.label}
              type="button"
              role="tab"
              id={`auth-tab-${mode.signIn ? "sign-in" : "create"}`}
              aria-selected={selected}
              aria-controls="auth-panel"
              tabIndex={selected ? 0 : -1}
              onClick={() => selectMode(mode.signIn)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                const next = !isSignInMode;
                selectMode(next);
                document
                  .getElementById(`auth-tab-${next ? "sign-in" : "create"}`)
                  ?.focus();
              }}
              className={`rounded-full px-3 py-2 text-sm font-medium transition duration-fast ${
                selected
                  ? "bg-[var(--color-glass-strong)] text-text-primary shadow-e0"
                  : "text-text-muted hover:text-text-primary"
              }`}
            >
              {mode.label}
            </button>
          );
        })}
      </div>

      <div
        id="auth-panel"
        role="tabpanel"
        aria-labelledby={`auth-tab-${isSignInMode ? "sign-in" : "create"}`}
        className="mt-6"
      >
        {error ? (
          <div
            role="alert"
            className="app-danger mb-5 rounded-lg px-4 py-3 text-sm leading-6"
          >
            {error}
          </div>
        ) : null}
        {notice ? (
          <div
            role="status"
            className="app-success mb-5 rounded-lg px-4 py-3 text-sm leading-6"
          >
            {notice}
          </div>
        ) : null}

        {awaitingCode ? (
          <SignUpCodeStep
            email={email.trim()}
            password={password}
            resendAfterSeconds={codeStep.resendAfterSeconds}
            onChangeEmail={() => setCodeStep(null)}
          />
        ) : (
          <>
            <Button
              type="button"
              variant="primary"
              size="lg"
              className="w-full justify-center gap-3"
              disabled={loading || googleLoading}
              onClick={() => void handleGoogleSignIn()}
            >
              <GoogleMark />
              {googleLoading ? "Opening Google..." : "Continue with Google"}
            </Button>

            <div className="my-6 flex items-center gap-3 text-2xs font-semibold uppercase tracking-[0.18em] text-text-muted">
              <span className="h-px flex-1 bg-[var(--color-border)]" />
              or with email
              <span className="h-px flex-1 bg-[var(--color-border)]" />
            </div>

            <form
              onSubmit={(event) => {
                event.preventDefault();
                void handleSubmit();
              }}
              className="space-y-4"
            >
              <div>
                <Input
                  type="email"
                  label="Email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    setNotice(null);
                  }}
                  onBlur={() => setEmailTouched(true)}
                  autoComplete="email"
                />
                {emailSuggestion ? (
                  <p className="mt-2 text-xs leading-5 text-text-muted" aria-live="polite">
                    Did you mean{" "}
                    <button
                      type="button"
                      onClick={() => setEmail(emailSuggestion)}
                      className="font-semibold text-text-primary underline decoration-[var(--color-border-strong)] underline-offset-4 transition duration-fast hover:decoration-[var(--color-text-primary)]"
                    >
                      {emailSuggestion}
                    </button>
                    ?
                  </p>
                ) : null}
              </div>

              <div>
                <PasswordField
                  label="Password"
                  labelAction={
                    isSignInMode ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handlePasswordReset()}
                        className="text-xs font-medium text-text-muted underline-offset-4 transition duration-fast hover:text-text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {resetLoading ? "Sending link..." : "Forgot password?"}
                      </button>
                    ) : null
                  }
                  placeholder={
                    isSignInMode
                      ? "Enter your password"
                      : `At least ${PASSWORD_MINIMUM_LENGTH} characters`
                  }
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete={isSignInMode ? "current-password" : "new-password"}
                  aria-describedby={
                    !isSignInMode && password ? "password-strength" : undefined
                  }
                />
                {!isSignInMode && password ? (
                  <PasswordStrength
                    id="password-strength"
                    assessment={passwordAssessment}
                    hint={
                      passwordProblem ??
                      "Good. Longer is stronger — a few ordinary words beat a short password with a symbol in it."
                    }
                  />
                ) : null}
              </div>

              <Button
                type="submit"
                disabled={busy}
                variant="secondary"
                size="lg"
                className="!mt-6 w-full"
              >
                {loading
                  ? isSignInMode
                    ? "Signing in..."
                    : "Sending code..."
                  : isSignInMode
                    ? "Sign in"
                    : "Email me a code"}
              </Button>
            </form>
          </>
        )}
      </div>
    </AuthShell>
  );
}
