import "server-only";

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { DocumentReference, Transaction } from "firebase-admin/firestore";
import {
  checkStoredEmailCode,
  decideEmailCodeSend,
  EMAIL_CODE_LENGTH,
  EMAIL_CODE_MAX_ATTEMPTS,
  EMAIL_CODE_MAX_SENDS_PER_HOUR,
  EMAIL_CODE_MAX_SENDS_PER_SENDER_PER_HOUR,
  EMAIL_CODE_TTL_MS,
  normaliseEmail,
  type EmailCodeFailure,
  type EmailCodeSendHistory,
  type StoredEmailCode,
} from "@/lib/auth/email-code";
import { getAdminDb } from "@/services/firebase/admin";

/**
 * Where emailed sign-up codes live between being sent and being typed back,
 * and the sending limits for them and for password-reset emails.
 *
 * One document per address and purpose, keyed by a hash, so the collection
 * never holds an email address in the clear -- and never the code either, only
 * a salted hash of it. Both collections are server-only in the rules; the
 * Admin SDK is the only thing that reads or writes them.
 */
const CODES = "emailCodes";
const SENDERS = "emailCodeSenders";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function codeRef(email: string) {
  return getAdminDb()
    .collection(CODES)
    .doc(sha256(`sign-up:${normaliseEmail(email)}`));
}

function hashCode(code: string, salt: string) {
  return sha256(`${salt}:${code}`);
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readHistory(data: Record<string, unknown> | undefined): EmailCodeSendHistory {
  return {
    lastSentAt: readNumber(data?.lastSentAt),
    windowStartedAt: readNumber(data?.windowStartedAt),
    sendsInWindow: readNumber(data?.sendsInWindow) ?? 0,
  };
}

function readStoredCode(data: Record<string, unknown> | undefined): StoredEmailCode | null {
  if (typeof data?.codeHash !== "string" || typeof data.salt !== "string") {
    return null;
  }
  return {
    codeHash: data.codeHash,
    salt: data.salt,
    expiresAt: readNumber(data.expiresAt) ?? 0,
    attempts: readNumber(data.attempts) ?? 0,
  };
}

type SendClaim =
  | { allowed: false; retryAfterSeconds: number }
  | {
      allowed: true;
      /** The address document's new sending history, for the caller to write. */
      address: { lastSentAt: number; windowStartedAt: number; sendsInWindow: number };
    };

/**
 * Whether one more email may go to an address, read and counted inside the
 * caller's transaction.
 *
 * `senderRef` is where the request came from (its IP), so one visitor cannot
 * send mail to a hundred different inboxes; sign-up codes and reset links
 * share that ceiling. The sender's count is written here, the address's is
 * handed back so the caller can write it with whatever else that document
 * holds.
 */
async function claimSend(
  transaction: Transaction,
  addressRef: DocumentReference,
  senderRef: DocumentReference | null,
  now: number
): Promise<SendClaim> {
  const addressSnapshot = await transaction.get(addressRef);
  const senderSnapshot = senderRef ? await transaction.get(senderRef) : null;

  const toAddress = decideEmailCodeSend(
    readHistory(addressSnapshot.data()),
    now,
    EMAIL_CODE_MAX_SENDS_PER_HOUR
  );
  if (!toAddress.allowed) {
    return { allowed: false, retryAfterSeconds: toAddress.retryAfterSeconds };
  }

  // No cooldown per sender: one household can reasonably sign up two people
  // a minute apart. The hourly ceiling is what matters there.
  const fromSender = senderRef
    ? decideEmailCodeSend(
        readHistory(senderSnapshot?.data()),
        now,
        EMAIL_CODE_MAX_SENDS_PER_SENDER_PER_HOUR,
        0
      )
    : null;
  if (fromSender && !fromSender.allowed) {
    return { allowed: false, retryAfterSeconds: fromSender.retryAfterSeconds };
  }

  if (senderRef && fromSender?.allowed) {
    transaction.set(senderRef, {
      lastSentAt: now,
      windowStartedAt: fromSender.windowStartedAt,
      sendsInWindow: fromSender.sendsInWindow,
      updatedAt: now,
    });
  }

  return {
    allowed: true,
    address: {
      lastSentAt: now,
      windowStartedAt: toAddress.windowStartedAt,
      sendsInWindow: toAddress.sendsInWindow,
    },
  };
}

function senderRefFor(senderKey: string | null) {
  return senderKey
    ? getAdminDb().collection(SENDERS).doc(sha256(`sender:${senderKey}`))
    : null;
}

export type EmailCodeIssue =
  | { issued: true; code: string }
  | { issued: false; retryAfterSeconds: number };

/**
 * Makes a new code for an address, replacing any earlier one, if the limits
 * allow another to be sent.
 *
 * The caller sends the mail; if that fails it hands the send back with
 * `withdrawEmailCode`.
 */
export async function issueEmailCode(input: {
  email: string;
  senderKey: string | null;
  now?: number;
}): Promise<EmailCodeIssue> {
  const now = input.now ?? Date.now();
  const addressRef = codeRef(input.email);
  const senderRef = senderRefFor(input.senderKey);
  const code = String(randomInt(0, 10 ** EMAIL_CODE_LENGTH)).padStart(
    EMAIL_CODE_LENGTH,
    "0"
  );
  const salt = randomBytes(16).toString("hex");

  return getAdminDb().runTransaction(async (transaction) => {
    const claim = await claimSend(transaction, addressRef, senderRef, now);
    if (!claim.allowed) {
      return { issued: false, retryAfterSeconds: claim.retryAfterSeconds };
    }

    transaction.set(addressRef, {
      codeHash: hashCode(code, salt),
      salt,
      expiresAt: now + EMAIL_CODE_TTL_MS,
      attempts: 0,
      ...claim.address,
      updatedAt: now,
    });
    return { issued: true, code };
  });
}

/**
 * Counts a password-reset email against the same limits as a sign-up code,
 * before anything is known about whether the address has an account -- so
 * the answer says nothing about that either. Nothing secret is stored: the
 * reset link itself is Firebase's.
 */
export async function claimPasswordResetSend(input: {
  email: string;
  senderKey: string | null;
  now?: number;
}): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
  const now = input.now ?? Date.now();
  const addressRef = getAdminDb()
    .collection(CODES)
    .doc(sha256(`password-reset:${normaliseEmail(input.email)}`));
  const senderRef = senderRefFor(input.senderKey);

  return getAdminDb().runTransaction(async (transaction) => {
    const claim = await claimSend(transaction, addressRef, senderRef, now);
    if (!claim.allowed) return claim;
    transaction.set(addressRef, { ...claim.address, updatedAt: now });
    return { allowed: true };
  });
}

/**
 * Takes back a code whose email never went out, so the cooldown does not make
 * somebody wait a minute for a mail that is not coming. It still counts toward
 * the hour, so a mailbox that keeps failing cannot be retried without end.
 */
export async function withdrawEmailCode(email: string) {
  await codeRef(email).set(
    { codeHash: null, salt: null, lastSentAt: null, updatedAt: Date.now() },
    { merge: true }
  );
}

export type EmailCodeRedemption =
  | { redeemed: true }
  | { redeemed: false; failure: EmailCodeFailure; attemptsLeft: number };

/**
 * Checks a typed code and, if it is right, spends it.
 *
 * In a transaction so two guesses at once cannot both be counted as the first.
 * A spent code is cleared rather than the document deleted, so the hourly
 * sending limit still remembers it.
 */
export async function redeemEmailCode(input: {
  email: string;
  code: string;
  now?: number;
}): Promise<EmailCodeRedemption> {
  const now = input.now ?? Date.now();
  const ref = codeRef(input.email);

  return getAdminDb().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const stored = readStoredCode(snapshot.data());
    const check = checkStoredEmailCode(stored, now);
    if (!check.usable || !stored) {
      return {
        redeemed: false,
        failure: check.usable ? "missing" : check.reason,
        attemptsLeft: 0,
      };
    }

    const expected = Buffer.from(stored.codeHash, "hex");
    const actual = Buffer.from(hashCode(input.code, stored.salt), "hex");
    const matches =
      expected.length === actual.length && timingSafeEqual(expected, actual);

    if (!matches) {
      const attempts = stored.attempts + 1;
      transaction.set(ref, { attempts, updatedAt: now }, { merge: true });
      return {
        redeemed: false,
        failure: "mismatch",
        attemptsLeft: Math.max(0, EMAIL_CODE_MAX_ATTEMPTS - attempts),
      };
    }

    transaction.set(
      ref,
      { codeHash: null, salt: null, attempts: 0, redeemedAt: now, updatedAt: now },
      { merge: true }
    );
    return { redeemed: true };
  });
}
