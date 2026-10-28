import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/*
 * Asking for a password-reset email. The route's own checks are real;
 * Firebase Admin, the send limits and the mailer are stubbed.
 */

const mocks = vi.hoisted(() => ({
  getUserByEmail: vi.fn(),
  generatePasswordResetLink: vi.fn(),
  claimPasswordResetSend: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock("@/services/firebase/admin", () => ({
  getAdminAuth: () => ({
    getUserByEmail: mocks.getUserByEmail,
    generatePasswordResetLink: mocks.generatePasswordResetLink,
  }),
}));

vi.mock("@/services/auth/email-code.server", () => ({
  claimPasswordResetSend: mocks.claimPasswordResetSend,
  issueEmailCode: vi.fn(),
  withdrawEmailCode: vi.fn(),
}));

vi.mock("@/services/email/send-email.server", () => ({
  sendEmail: mocks.sendEmail,
  EmailUnavailableError: class EmailUnavailableError extends Error {},
}));

let post: (request: NextRequest) => Promise<Response>;

function request(body: Record<string, unknown>, origin = "http://localhost") {
  return new Request("http://localhost/api/auth/password-reset", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

beforeAll(async () => {
  ({ POST: post } = await import("@/app/api/auth/password-reset/route"));
}, 120_000);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.claimPasswordResetSend.mockResolvedValue({ allowed: true });
  mocks.getUserByEmail.mockResolvedValue({ uid: "sam" });
  mocks.generatePasswordResetLink.mockResolvedValue(
    "https://demo.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=one-time&apiKey=key"
  );
  mocks.sendEmail.mockResolvedValue("sent");
});

describe("password reset route", () => {
  it("emails a link to Jami's own reset page carrying only Firebase's code", async () => {
    const response = await post(request({ email: " Sam@Example.com " }));
    expect(response.status).toBe(200);
    expect(mocks.generatePasswordResetLink).toHaveBeenCalledWith("sam@example.com");

    const mail = mocks.sendEmail.mock.calls[0][0];
    expect(mail.to).toBe("sam@example.com");
    expect(mail.subject).toBe("Reset your Jami password");
    expect(mail.text).toContain(
      "http://localhost/auth/action?mode=resetPassword&oobCode=one-time"
    );
    expect(mail.html).not.toContain("firebaseapp.com");
    expect(mail.text).not.toContain("apiKey");
  });

  it("answers the same for an address with no account, and sends nothing", async () => {
    mocks.getUserByEmail.mockRejectedValue({ code: "auth/user-not-found" });
    const response = await post(request({ email: "nobody@example.com" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.generatePasswordResetLink).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("counts the send before looking the account up, so limits say nothing about it", async () => {
    mocks.claimPasswordResetSend.mockResolvedValue({ allowed: false, retryAfterSeconds: 40 });
    const response = await post(request({ email: "sam@example.com" }));
    expect(response.status).toBe(429);
    expect((await response.json()).error).toBe(
      "Wait 40 seconds before asking for another reset email."
    );
    expect(mocks.getUserByEmail).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("refuses a request from another site", async () => {
    const response = await post(request({ email: "sam@example.com" }, "https://evil.example"));
    expect(response.status).toBe(403);
    expect(mocks.claimPasswordResetSend).not.toHaveBeenCalled();
  });

  it("refuses an address that cannot be one", async () => {
    const response = await post(request({ email: "not an email" }));
    expect(response.status).toBe(400);
    expect(mocks.claimPasswordResetSend).not.toHaveBeenCalled();
  });

  it("says so when the mail cannot be sent", async () => {
    mocks.sendEmail.mockRejectedValue(new Error("relay down"));
    const response = await post(request({ email: "sam@example.com" }));
    expect(response.status).toBe(502);
    expect((await response.json()).code).toBe("email/send-failed");
  });

  it("points production links at Jami's configured address, never the request's host", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://jami.study");
    try {
      const forged = new Request("https://attacker.example/api/auth/password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "sam@example.com" }),
      }) as unknown as NextRequest;
      await post(forged);
      expect(mocks.sendEmail.mock.calls[0][0].text).toContain(
        "https://jami.study/auth/action?mode=resetPassword&oobCode=one-time"
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
