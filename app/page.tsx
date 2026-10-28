"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { signInWithGoogle, handleGoogleRedirectResult } from "@/services/auth";
import { getAuthErrorCode, getFriendlyAuthError } from "@/lib/auth/errors";
import { listenToAuth } from "@/services/auth/auth-listener";
import { readLastRoute } from "@/lib/app/last-route";
import Link from "next/link";
import { BrandMark, ButtonLink } from "@/components/ui";
import Button from "@/components/ui/Button";
import GoogleMark from "@/components/auth/GoogleMark";
import LandingPreview from "@/components/landing/LandingPreview";

/**
 * Said once, near the foot of the page, so the headline can stay about exams
 * without shutting out everyone else: everything except past papers works for
 * any subject, which is most of what a university student needs.
 */
const ANY_SUBJECT_EXAMPLES = [
  "History",
  "Spanish",
  "Economics",
  "Computer Science",
  "Law",
  "Psychology",
  "Medicine",
  "Music",
];

/**
 * How long to wait for the session to be restored before offering sign-in.
 *
 * Only reached if the auth listener never reports at all, which means something
 * is wrong. Showing the sign-in form is the right thing to do then -- it is
 * still usable -- but not a moment sooner, or an installed app shows its
 * sign-in screen every single launch to somebody who is already signed in.
 */
const AUTH_RESTORE_TIMEOUT_MS = 5_000;

export default function Home() {
  const router = useRouter();
  const routerRef = useRef(router);
  const redirectStartedRef = useRef(false);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Whether it is yet known if anyone is signed in.
   *
   * Installed as a PWA this page *is* the launch screen, and it used to render
   * the sign-in form immediately -- so every launch flashed "sign in" at
   * somebody who already had, until the session finished restoring a moment
   * later. Nothing is offered until the answer is known.
   */
  const [authResolved, setAuthResolved] = useState(false);

  useEffect(() => {
    routerRef.current = router;
  }, [router]);

  const openApp = useCallback(() => {
    if (redirectStartedRef.current) {
      return;
    }

    redirectStartedRef.current = true;
    // Back to whatever they had open, if this launch is the same session
    // resumed. A properly closed app has forgotten, and opens at home.
    routerRef.current.replace(readLastRoute());
  }, []);

  useEffect(() => {
    let settled = false;
    const resolve = () => {
      settled = true;
      setAuthResolved(true);
    };

    const unsubscribe = listenToAuth((user) => {
      if (user) {
        openApp();
        return;
      }
      resolve();
    });

    void handleGoogleRedirectResult()
      .then((user) => {
        if (user) {
          openApp();
        } else {
          setIsSigningIn(false);
        }
      })
      .catch((nextError) => {
        const maybeCode = getAuthErrorCode(nextError);
        setError(getFriendlyAuthError(maybeCode));
        setIsSigningIn(false);
        resolve();
        console.error("Google redirect sign-in failed.", {
          code: maybeCode ?? "unknown",
        });
      });

    const timeout = window.setTimeout(() => {
      if (!settled) setAuthResolved(true);
    }, AUTH_RESTORE_TIMEOUT_MS);

    return () => {
      window.clearTimeout(timeout);
      unsubscribe();
    };
  }, [openApp]);

  if (!authResolved) {
    return (
      <main
        data-app-surface="true"
        data-auth-restoring="true"
        aria-busy="true"
        /*
         * Pinned to the viewport and centred by the grid, rather than centred
         * inside a `100dvh` column.
         *
         * `dvh` is the *dynamic* viewport height, which on iOS is still
         * settling while the app opens -- and anything centred against it moves
         * as it settles, which is the mark appearing off-centre and then
         * jumping. `fixed inset-0` cannot be measured wrongly because it is not
         * measured: it is the viewport, whatever the viewport currently is.
         */
        className="fixed inset-0 grid place-items-center overflow-hidden bg-[var(--app-background)] text-text-primary"
      >
        {/* The only place the mark appears while the app opens: the launch
            image iOS shows first is a flat colour, so this is not handing over
            from a second one. The halo is sized from the mark, so it is the
            same treatment the sign-in screen gives it rather than a new one. */}
        <div
          className="login-brand-halo [--brand-halo-size:clamp(4.5rem,min(16vw,16vh),8rem)]"
          aria-hidden="true"
        >
          <span className="login-brand-spark login-brand-spark-one" />
          <span className="login-brand-spark login-brand-spark-two" />
          <span className="login-brand-spark login-brand-spark-three" />
          <BrandMark size="launch" />
        </div>
        <span className="sr-only">Opening Jami</span>
      </main>
    );
  }

  const handleGoogleSignIn = async () => {
    if (isSigningIn) return;
    setIsSigningIn(true);
    setError(null);

    try {
      const user = await signInWithGoogle();
      if (user) {
        openApp();
      }
    } catch (nextError) {
      const maybeCode = getAuthErrorCode(nextError);
      setError(getFriendlyAuthError(maybeCode));
      setIsSigningIn(false);
    }
  };

  return (
    <main
      data-app-surface="true"
      className="relative min-h-[100dvh] overflow-x-hidden text-text-primary"
    >
      <header className="relative mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 pt-[max(1.25rem,env(safe-area-inset-top))] sm:px-8 sm:pt-7">
        <Link
          href="/"
          className="inline-flex items-center gap-2.5 rounded-md text-lg font-semibold tracking-tight text-text-primary"
        >
          <BrandMark size="md" />
          Jami
        </Link>
        <nav className="flex items-center gap-1 sm:gap-2">
          <Link
            href="/auth"
            className="inline-flex rounded-full border border-[var(--color-border-strong)] bg-[var(--color-glass-subtle)] px-4 py-2 text-sm font-medium text-text-primary transition duration-fast hover:border-[var(--button-secondary-border-hover)] hover:bg-[var(--color-glass-medium)]"
          >
            Sign in
          </Link>
        </nav>
      </header>

      {/*
        * Headline and sign-in first in the source, the picture after, so a
        * phone -- which follows the source rather than the columns -- puts the
        * way in directly under the reason for it.
        */}
      <section className="relative mx-auto grid w-full max-w-6xl items-center gap-10 px-5 pb-16 pt-12 sm:px-8 sm:pt-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.02fr)] lg:gap-14 lg:pb-24 lg:pt-20">
        <div className="animate-slide-up">
          <h1 className="max-w-xl text-balance text-4xl font-semibold leading-[1.08] tracking-[-0.035em] text-text-primary sm:text-5xl">
            Practice like the exam.{" "}
            <span className="landing-accent block">Revise what it shows you.</span>
          </h1>
          <p className="mt-5 max-w-lg text-base leading-7 text-text-secondary sm:text-lg sm:leading-8">
            Answer real past-paper questions and see which marks you lost, and
            why. Jami connects those answers with your notebooks and
            flashcards, so you always know what to revise next.
          </p>

          {error ? (
            <div
              role="alert"
              className="app-danger mt-6 max-w-lg rounded-lg px-4 py-3 text-sm font-medium"
            >
              {error}
            </div>
          ) : null}

          <div className="mt-8 flex max-w-lg flex-col gap-3 sm:flex-row">
            <Button
              disabled={isSigningIn}
              onClick={() => void handleGoogleSignIn()}
              variant="primary"
              size="lg"
              className="w-full justify-center gap-3 sm:w-auto sm:px-6"
            >
              <GoogleMark />
              {isSigningIn ? "Signing in..." : "Continue with Google"}
            </Button>
            <Button
              onClick={() => router.push("/auth")}
              variant="secondary"
              size="lg"
              className="w-full justify-center sm:w-auto sm:px-6"
            >
              Continue with email
            </Button>
          </div>
          <p className="mt-4 text-xs leading-5 text-text-muted">
            Your decks, notebooks and progress sync across all your devices.
          </p>
        </div>

        <div className="animate-fade-in">
          <LandingPreview />
        </div>
      </section>

      <section className="relative mx-auto flex w-full max-w-3xl flex-col items-center px-5 pb-20 text-center sm:px-8 lg:pb-24">
        <h2 className="relative text-balance text-2xl font-semibold tracking-tight text-text-primary sm:text-3xl">
          Not only exams.{" "}
          <span className="landing-accent">Any subject you study.</span>
        </h2>
        <p className="relative mt-3 max-w-md text-sm leading-6 text-text-secondary sm:text-base sm:leading-7">
          Folders, notebooks, flashcards and Jami work with your own notes,
          at school or at university.
        </p>
        <ul
          aria-label="For example"
          className="relative mt-6 flex flex-wrap justify-center gap-2"
        >
          {ANY_SUBJECT_EXAMPLES.map((subject) => (
            <li
              key={subject}
              className="app-chip rounded-full px-3 py-1 text-xs font-medium transition duration-fast hover:-translate-y-0.5"
            >
              {subject}
            </li>
          ))}
        </ul>
        <ButtonLink
          href="/auth"
          variant="primary"
          size="lg"
          className="relative mt-8 justify-center px-8"
        >
          Get started
        </ButtonLink>
      </section>

      <footer className="relative mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-3 border-t border-[var(--color-border)] px-5 pb-[max(1.75rem,env(safe-area-inset-bottom))] pt-7 text-xs text-text-muted sm:flex-row sm:px-8">
        <span className="inline-flex items-center gap-2 font-medium text-text-secondary">
          <BrandMark size="sm" />
          Jami
        </span>
        <span>Revision for GCSE, A-level and beyond.</span>
      </footer>
    </main>
  );
}
