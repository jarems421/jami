import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  auth: {
    currentUser: null as null | {
      uid: string;
      email: string | null;
      providerData: Array<{ providerId: string }>;
      getIdToken: (forceRefresh?: boolean) => Promise<string>;
    },
  },
  emailCredential: vi.fn(),
  getRedirectResult: vi.fn(),
  reauthenticateWithCredential: vi.fn(),
  reauthenticateWithPopup: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  setPersistence: vi.fn(),
  signOut: vi.fn(),
  signInWithPopup: vi.fn(),
  signInWithRedirect: vi.fn(),
}));

vi.mock("@/services/firebase/client", () => ({
  auth: authMocks.auth,
}));

vi.mock("firebase/auth", () => ({
  EmailAuthProvider: { credential: authMocks.emailCredential },
  GoogleAuthProvider: class {},
  getRedirectResult: authMocks.getRedirectResult,
  reauthenticateWithCredential: authMocks.reauthenticateWithCredential,
  reauthenticateWithPopup: authMocks.reauthenticateWithPopup,
  sendPasswordResetEmail: authMocks.sendPasswordResetEmail,
  signInWithPopup: authMocks.signInWithPopup,
  signInWithRedirect: authMocks.signInWithRedirect,
  signOut: authMocks.signOut,
  createUserWithEmailAndPassword: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  setPersistence: authMocks.setPersistence,
  browserLocalPersistence: {},
}));

afterEach(() => {
  authMocks.auth.currentUser = null;
  vi.unstubAllGlobals();
});

describe("createRetryableInitializer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The first test pays the cold import of "@/services/auth" (which pulls the
  // whole firebase/firestore package); under parallel suite load that alone
  // can pass five seconds, so give it explicit room.
  it("retries after an initialization failure", async () => {
    let callCount = 0;

    const initialize = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error("first init failed");
      }
    });

    const { createRetryableInitializer } = await import("@/services/auth");
    const init = createRetryableInitializer(initialize);

    await expect(init()).rejects.toThrow("first init failed");
    await expect(init()).resolves.toBeUndefined();

    expect(initialize).toHaveBeenCalledTimes(2);
  }, 30_000);

  it("memoizes successful initialization", async () => {
    const initialize = vi.fn(async () => undefined);
    const { createRetryableInitializer } = await import("@/services/auth");
    const init = createRetryableInitializer(initialize);

    await expect(init()).resolves.toBeUndefined();
    await expect(init()).resolves.toBeUndefined();
    await expect(init()).resolves.toBeUndefined();

    expect(initialize).toHaveBeenCalledTimes(1);
  });
});

describe("signInWithGoogle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.setPersistence.mockResolvedValue(undefined);
    authMocks.signInWithRedirect.mockResolvedValue(undefined);
  });

  it("uses popup sign-in in an installed PWA", async () => {
    vi.stubGlobal("window", {
      matchMedia: vi.fn(() => ({ matches: true })),
      navigator: { standalone: true },
    });
    const user = { uid: "pwa-user" };
    authMocks.signInWithPopup.mockResolvedValue({ user });

    const { signInWithGoogle } = await import("@/services/auth");

    await expect(signInWithGoogle()).resolves.toBe(user);
    expect(authMocks.signInWithPopup).toHaveBeenCalledTimes(1);
    expect(authMocks.signInWithRedirect).not.toHaveBeenCalled();
  });

  it.each([
    { mode: "display mode", displayMode: true, navigatorStandalone: false },
    { mode: "iOS home screen", displayMode: false, navigatorStandalone: true },
  ])(
    "does not send a $mode PWA into the broken redirect fallback",
    async ({ displayMode, navigatorStandalone }) => {
      vi.stubGlobal("window", {
        matchMedia: vi.fn(() => ({ matches: displayMode })),
        navigator: { standalone: navigatorStandalone },
      });
      const popupError = { code: "auth/popup-blocked" };
      authMocks.signInWithPopup.mockRejectedValue(popupError);

      const { signInWithGoogle } = await import("@/services/auth");

      await expect(signInWithGoogle()).rejects.toBe(popupError);
      expect(authMocks.signInWithRedirect).not.toHaveBeenCalled();
    }
  );

  it("retains redirect fallback for a blocked popup in a browser tab", async () => {
    vi.stubGlobal("window", {
      matchMedia: vi.fn(() => ({ matches: false })),
      navigator: {},
    });
    authMocks.signInWithPopup.mockRejectedValue({ code: "auth/popup-blocked" });

    const { signInWithGoogle } = await import("@/services/auth");

    await expect(signInWithGoogle()).resolves.toBeNull();
    expect(authMocks.signInWithRedirect).toHaveBeenCalledTimes(1);
  });
});

describe("account recovery and deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.setPersistence.mockResolvedValue(undefined);
    authMocks.sendPasswordResetEmail.mockResolvedValue(undefined);
    authMocks.signOut.mockResolvedValue(undefined);
  });

  it("asks Jami's server to send the password reset email", async () => {
    const { sendPasswordReset } = await import("@/services/auth");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ ok: true }));

    try {
      await expect(sendPasswordReset(" student@example.com ")).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/auth/password-reset",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ email: "student@example.com" }),
        })
      );
      expect(authMocks.sendPasswordResetEmail).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("reauthenticates password accounts before retrying deletion", async () => {
    const credential = { providerId: "password" };
    authMocks.emailCredential.mockReturnValue(credential);
    authMocks.reauthenticateWithCredential.mockResolvedValue(undefined);
    authMocks.auth.currentUser = {
      uid: "user-a",
      email: "student@example.com",
      providerData: [{ providerId: "password" }],
      getIdToken: vi.fn(async () => "fresh-token"),
    };
    const { reauthenticateForAccountDeletion } = await import(
      "@/services/auth"
    );

    await expect(
      reauthenticateForAccountDeletion("current-password")
    ).resolves.toBeUndefined();
    expect(authMocks.emailCredential).toHaveBeenCalledWith(
      "student@example.com",
      "current-password"
    );
    expect(authMocks.reauthenticateWithCredential).toHaveBeenCalledWith(
      authMocks.auth.currentUser,
      credential
    );
  });

  it("authorizes the server deletion route and clears the local session", async () => {
    authMocks.auth.currentUser = {
      uid: "user-a",
      email: "student@example.com",
      providerData: [{ providerId: "password" }],
      getIdToken: vi.fn(async () => "fresh-token"),
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const phases: string[] = [];
    const { deleteAccount } = await import("@/services/auth");

    await expect(
      deleteAccount((phase) => phases.push(phase))
    ).resolves.toBeUndefined();

    expect(phases).toEqual(["authorizing", "deleting"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/account/delete",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          Authorization: "Bearer fresh-token",
        }),
      })
    );
    expect(authMocks.signOut).toHaveBeenCalledWith(authMocks.auth);
  });
});
