import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The code store against an in-memory Firestore that serialises transactions
 * the way the real one does, so the attempt counting can be trusted.
 */
const mocks = vi.hoisted(() => {
  const store = new Map<string, Record<string, unknown>>();
  let inFlight = false;

  type Ref = { path: string; set: (value: Record<string, unknown>, options?: { merge?: boolean }) => Promise<void> };

  const write = (path: string, value: Record<string, unknown>, merge?: boolean) => {
    store.set(path, merge ? { ...store.get(path), ...value } : { ...value });
  };

  const db = {
    collection: (name: string) => ({
      doc: (id: string): Ref => ({
        path: `${name}/${id}`,
        set: async (value, options) => write(`${name}/${id}`, value, options?.merge),
      }),
    }),
    runTransaction: async <T>(
      run: (transaction: {
        get: (ref: Ref) => Promise<{ data: () => Record<string, unknown> | undefined }>;
        set: (ref: Ref, value: Record<string, unknown>, options?: { merge?: boolean }) => void;
      }) => Promise<T>
    ): Promise<T> => {
      while (inFlight) await new Promise((resolve) => setImmediate(resolve));
      inFlight = true;
      try {
        return await run({
          get: async (ref) => ({ data: () => store.get(ref.path) }),
          set: (ref, value, options) => write(ref.path, value, options?.merge),
        });
      } finally {
        inFlight = false;
      }
    },
  };

  return { store, db };
});

vi.mock("@/services/firebase/admin", () => ({ getAdminDb: () => mocks.db }));

const { claimPasswordResetSend, issueEmailCode, redeemEmailCode, withdrawEmailCode } = await import(
  "@/services/auth/email-code.server"
);
const { EMAIL_CODE_MAX_ATTEMPTS, EMAIL_CODE_TTL_MS } = await import("@/lib/auth/email-code");

const NOW = 1_800_000_000_000;
const EMAIL = "sam@example.com";

beforeEach(() => mocks.store.clear());

async function issue(now = NOW, senderKey: string | null = "203.0.113.7") {
  const result = await issueEmailCode({ email: EMAIL, senderKey, now });
  if (!result.issued) throw new Error("expected a code");
  return result.code;
}

describe("email code store", () => {
  it("issues a six-digit code and never stores it or the address in the clear", async () => {
    const code = await issue();
    expect(code).toMatch(/^\d{6}$/);
    const stored = JSON.stringify([...mocks.store.entries()]);
    expect(stored).not.toContain(code);
    expect(stored).not.toContain(EMAIL);
  });

  it("redeems the right code once, and only once", async () => {
    const code = await issue();
    await expect(
      redeemEmailCode({ email: "SAM@example.com ", code, now: NOW + 1_000 })
    ).resolves.toEqual({ redeemed: true });
    await expect(
      redeemEmailCode({ email: EMAIL, code, now: NOW + 2_000 })
    ).resolves.toMatchObject({ redeemed: false, failure: "missing" });
  });

  it("throws the code away after too many wrong guesses", async () => {
    const code = await issue();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let attempt = 1; attempt <= EMAIL_CODE_MAX_ATTEMPTS; attempt += 1) {
      const result = await redeemEmailCode({ email: EMAIL, code: wrong, now: NOW + attempt });
      expect(result).toEqual({
        redeemed: false,
        failure: "mismatch",
        attemptsLeft: EMAIL_CODE_MAX_ATTEMPTS - attempt,
      });
    }
    // Even the right code is refused now.
    await expect(
      redeemEmailCode({ email: EMAIL, code, now: NOW + 100 })
    ).resolves.toMatchObject({ redeemed: false, failure: "exhausted" });
  });

  it("refuses an expired code", async () => {
    const code = await issue();
    await expect(
      redeemEmailCode({ email: EMAIL, code, now: NOW + EMAIL_CODE_TTL_MS })
    ).resolves.toMatchObject({ redeemed: false, failure: "expired" });
  });

  it("holds a second send to the cooldown, and a new code replaces the old", async () => {
    const first = await issue();
    const tooSoon = await issueEmailCode({ email: EMAIL, senderKey: null, now: NOW + 5_000 });
    expect(tooSoon).toMatchObject({ issued: false });

    const second = await issue(NOW + 61_000, null);
    if (first !== second) {
      await expect(
        redeemEmailCode({ email: EMAIL, code: first, now: NOW + 62_000 })
      ).resolves.toMatchObject({ redeemed: false, failure: "mismatch" });
    }
    await expect(
      redeemEmailCode({ email: EMAIL, code: second, now: NOW + 63_000 })
    ).resolves.toEqual({ redeemed: true });
  });

  it("limits one sender across many inboxes", async () => {
    let refused = false;
    for (let index = 0; index < 25; index += 1) {
      const result = await issueEmailCode({
        email: `person${index}@example.com`,
                senderKey: "198.51.100.1",
        now: NOW + index,
      });
      if (!result.issued) {
        refused = true;
        expect(index).toBe(20);
        break;
      }
    }
    expect(refused).toBe(true);
  });

  it("lets a code whose mail failed be asked for again straight away", async () => {
    await issue();
    await withdrawEmailCode(EMAIL);
    await expect(
      issueEmailCode({ email: EMAIL, senderKey: null, now: NOW + 1_000 })
    ).resolves.toMatchObject({ issued: true });
  });

  it("holds reset emails to the cooldown without touching a sign-up code", async () => {
    const code = await issue();
    await expect(
      claimPasswordResetSend({ email: EMAIL, senderKey: null, now: NOW + 1_000 })
    ).resolves.toEqual({ allowed: true });
    await expect(
      claimPasswordResetSend({ email: EMAIL, senderKey: null, now: NOW + 5_000 })
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      redeemEmailCode({ email: EMAIL, code, now: NOW + 6_000 })
    ).resolves.toEqual({ redeemed: true });
    expect([...mocks.store.keys()].join(" ")).not.toContain(EMAIL);
  });

  it("counts reset emails and sign-up codes from one sender together", async () => {
    for (let index = 0; index < 10; index += 1) {
      await issueEmailCode({ email: `a${index}@example.com`, senderKey: "198.51.100.2", now: NOW + index });
      await claimPasswordResetSend({ email: `b${index}@example.com`, senderKey: "198.51.100.2", now: NOW + index });
    }
    await expect(
      claimPasswordResetSend({ email: "c@example.com", senderKey: "198.51.100.2", now: NOW + 20 })
    ).resolves.toMatchObject({ allowed: false });
  });
});
