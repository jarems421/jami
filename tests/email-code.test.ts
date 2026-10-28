import { describe, expect, it } from "vitest";
import {
  accountMayUseAi,
  checkStoredEmailCode,
  decideEmailCodeSend,
  describeEmailCodeFailure,
  describeEmailCodeWait,
  EMAIL_CODE_MAX_ATTEMPTS,
  EMAIL_CODE_MAX_SENDS_PER_HOUR,
  EMAIL_CODE_RESEND_COOLDOWN_MS,
  isCompleteEmailCode,
  isPlausibleEmail,
  normaliseEmail,
  sanitiseEmailCodeInput,
} from "@/lib/auth/email-code";
import { suggestEmailCorrection } from "@/lib/auth/email-typos";
import { buildCodeEmail } from "@/lib/auth/code-email";
import {
  buildPasswordResetEmail,
  buildPasswordResetUrl,
} from "@/lib/auth/password-reset-email";

const HOUR_MS = 60 * 60_000;
const NOW = 1_800_000_000_000;

describe("email addresses", () => {
  it("compares addresses without case or surrounding space", () => {
    expect(normaliseEmail("  Sam@Example.COM ")).toBe("sam@example.com");
  });

  it("accepts real-looking addresses and refuses obvious non-addresses", () => {
    expect(isPlausibleEmail("sam@example.com")).toBe(true);
    expect(isPlausibleEmail("sam.jones+revision@student.lboro.ac.uk")).toBe(true);
    for (const bad of ["sam", "sam@", "@example.com", "sam@example", "sam jones@example.com"]) {
      expect(isPlausibleEmail(bad)).toBe(false);
    }
  });
});

describe("typo suggestions", () => {
  it("offers the provider a slip was aiming for", () => {
    expect(suggestEmailCorrection("sam@gmial.com")).toBe("sam@gmail.com");
    expect(suggestEmailCorrection("sam@gmail.co")).toBe("sam@gmail.com");
    expect(suggestEmailCorrection("sam@gmail.con")).toBe("sam@gmail.com");
    expect(suggestEmailCorrection("sam@hotmial.co.uk")).toBe("sam@hotmail.co.uk");
    expect(suggestEmailCorrection("Sam.Jones@outlok.com")).toBe("Sam.Jones@outlook.com");
  });

  it("leaves real domains alone, including ones next to a big provider", () => {
    for (const email of [
      "sam@gmail.com",
      "sam@mail.com",
      "sam@hotmail.co.uk",
      "sam@student.lboro.ac.uk",
      "sam@school.org",
    ]) {
      expect(suggestEmailCorrection(email)).toBeNull();
    }
  });

  it("says nothing about something that is not an address yet", () => {
    expect(suggestEmailCorrection("sam")).toBeNull();
    expect(suggestEmailCorrection("sam@")).toBeNull();
  });
});

describe("the code field", () => {
  it("keeps six digits from whatever is typed or pasted", () => {
    expect(sanitiseEmailCodeInput("123 456")).toBe("123456");
    expect(sanitiseEmailCodeInput("Your code: 987-654-321")).toBe("987654");
    expect(isCompleteEmailCode("12345")).toBe(false);
    expect(isCompleteEmailCode("123456")).toBe(true);
    expect(isCompleteEmailCode("12345a")).toBe(false);
  });
});

describe("sending limits", () => {
  const fresh = { lastSentAt: null, windowStartedAt: null, sendsInWindow: 0 };

  it("lets the first code go and starts counting", () => {
    expect(decideEmailCodeSend(fresh, NOW, EMAIL_CODE_MAX_SENDS_PER_HOUR)).toEqual({
      allowed: true,
      windowStartedAt: NOW,
      sendsInWindow: 1,
    });
  });

  it("makes a second code wait out the cooldown", () => {
    const decision = decideEmailCodeSend(
      { lastSentAt: NOW, windowStartedAt: NOW, sendsInWindow: 1 },
      NOW + 20_000,
      EMAIL_CODE_MAX_SENDS_PER_HOUR
    );
    expect(decision).toEqual({
      allowed: false,
      retryAfterSeconds: (EMAIL_CODE_RESEND_COOLDOWN_MS - 20_000) / 1000,
    });
  });

  it("stops at the hourly ceiling and resets after the hour", () => {
    const full = {
      lastSentAt: NOW,
      windowStartedAt: NOW,
      sendsInWindow: EMAIL_CODE_MAX_SENDS_PER_HOUR,
    };
    const blocked = decideEmailCodeSend(full, NOW + 10 * 60_000, EMAIL_CODE_MAX_SENDS_PER_HOUR);
    expect(blocked.allowed).toBe(false);

    const later = decideEmailCodeSend(full, NOW + HOUR_MS + 1, EMAIL_CODE_MAX_SENDS_PER_HOUR);
    expect(later).toEqual({ allowed: true, windowStartedAt: NOW + HOUR_MS + 1, sendsInWindow: 1 });
  });

  it("says how long to wait in words", () => {
    expect(describeEmailCodeWait(1)).toBe("Wait 1 second before asking for another code.");
    expect(describeEmailCodeWait(45)).toContain("45 seconds");
    expect(describeEmailCodeWait(20 * 60)).toContain("20 minutes");
  });
});

describe("stored codes", () => {
  const stored = { codeHash: "hash", salt: "salt", expiresAt: NOW + 60_000, attempts: 0 };

  it("is usable until it expires or runs out of tries", () => {
    expect(checkStoredEmailCode(stored, NOW)).toEqual({ usable: true });
    expect(checkStoredEmailCode(null, NOW)).toEqual({ usable: false, reason: "missing" });
    expect(checkStoredEmailCode(stored, NOW + 60_000)).toEqual({
      usable: false,
      reason: "expired",
    });
    expect(
      checkStoredEmailCode({ ...stored, attempts: EMAIL_CODE_MAX_ATTEMPTS }, NOW)
    ).toEqual({ usable: false, reason: "exhausted" });
  });

  it("counts down the tries left on a wrong code", () => {
    expect(describeEmailCodeFailure("mismatch", 2)).toContain("2 tries left");
    expect(describeEmailCodeFailure("mismatch", 1)).toContain("1 try left");
    expect(describeEmailCodeFailure("mismatch", 0)).toContain("Send a new one");
  });
});

describe("which accounts may use AI", () => {
  const LIVE = NOW;
  const unconfirmed = {
    email: "sam@example.com",
    emailVerified: false,
    providerIds: ["password"],
  };

  it("never refuses an account that existed before code sign-up went live", () => {
    expect(accountMayUseAi({ ...unconfirmed, createdAt: LIVE - 1 }, LIVE)).toBe(true);
    expect(accountMayUseAi({ ...unconfirmed, createdAt: LIVE - 400 * 86_400_000 }, LIVE)).toBe(true);
  });

  it("refuses an unconfirmed password account made after, which only going around the form can make", () => {
    expect(accountMayUseAi({ ...unconfirmed, createdAt: LIVE + 1 }, LIVE)).toBe(false);
  });

  it("allows confirmed and Google accounts whenever they were made", () => {
    expect(
      accountMayUseAi({ ...unconfirmed, emailVerified: true, createdAt: LIVE + 1 }, LIVE)
    ).toBe(true);
    expect(
      accountMayUseAi({ ...unconfirmed, providerIds: ["google.com"], createdAt: LIVE + 1 }, LIVE)
    ).toBe(true);
  });

  it("refuses nobody until the start time is known, or when an account's age is not", () => {
    expect(accountMayUseAi({ ...unconfirmed, createdAt: LIVE + 1 }, null)).toBe(true);
    expect(accountMayUseAi({ ...unconfirmed, createdAt: null }, LIVE)).toBe(true);
  });
});

describe("the code email", () => {
  it("puts the code in the subject, the body and the plain-text part", () => {
    const email = buildCodeEmail({ code: "042917" });
    expect(email.subject).toBe("042917 is your Jami code");
    expect(email.html).toContain(">042917<");
    expect(email.text).toContain("042917");
    expect(email.html).toContain("Welcome to Jami");
  });

  it("carries no link and no image, which mail filters read as phishing from a hosting domain", () => {
    const email = buildCodeEmail({ code: "111111" });
    expect(email.html).not.toMatch(/<img|<a\s|href=|src=|https?:\/\//i);
    expect(email.text).not.toMatch(/https?:\/\//i);
  });

  it("is signed by the Jami team", () => {
    const email = buildCodeEmail({ code: "111111" });
    expect(email.html).toContain("The Jami team");
    expect(email.text).toContain("The Jami team");
  });
});

describe("the password reset email", () => {
  const resetUrl = buildPasswordResetUrl("https://jami.study", "a&b=c");

  it("links only to Jami's own reset page, with the code safely encoded", () => {
    expect(resetUrl).toBe("https://jami.study/auth/action?mode=resetPassword&oobCode=a%26b%3Dc");
    const email = buildPasswordResetEmail({ resetUrl, email: "sam@example.com" });
    const links = [...email.html.matchAll(/https?:\/\/[^"<\s]+/g)].map(([link]) => link);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link.startsWith("https://jami.study/")).toBe(true);
    expect(email.text).toContain(resetUrl);
  });

  it("carries no image and is signed by the Jami team", () => {
    const email = buildPasswordResetEmail({ resetUrl, email: "sam@example.com" });
    expect(email.html).not.toMatch(/<img|src=/i);
    expect(email.subject).toBe("Reset your Jami password");
    expect(email.text).toContain("The Jami team");
  });
});
