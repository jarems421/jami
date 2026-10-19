import { describe, expect, it } from "vitest";
import {
  extractStreamingAnswer,
  isRunawayAnswerTail,
  readCompletedStreamingAnswer,
  readStreamingAnswerTail,
} from "@/lib/ai/streaming-answer";

/**
 * The assistant streams structured JSON, so the client sees the answer field
 * long before the object closes. Everything here is a prefix of a valid
 * response, which is exactly what arrives mid-stream.
 */
describe("extractStreamingAnswer", () => {
  it("returns nothing until the field has started", () => {
    expect(extractStreamingAnswer("")).toBe("");
    expect(extractStreamingAnswer("{")).toBe("");
    expect(extractStreamingAnswer('{"ans')).toBe("");
    expect(extractStreamingAnswer('{"answer":"')).toBe("");
  });

  it("returns the answer so far while the string is still open", () => {
    expect(extractStreamingAnswer('{"answer":"Photosynthesis is')).toBe(
      "Photosynthesis is"
    );
  });

  it("returns the whole answer once the string closes", () => {
    expect(
      extractStreamingAnswer('{"answer":"All done.","sourceRefs":["S1"]}')
    ).toBe("All done.");
  });

  it("does not stop at an escaped quote", () => {
    expect(extractStreamingAnswer('{"answer":"She said \\"go\\" firmly')).toBe(
      'She said "go" firmly'
    );
  });

  it("handles an escaped backslash before a closing quote", () => {
    expect(extractStreamingAnswer('{"answer":"path\\\\","sourceRefs":[]}')).toBe(
      "path\\"
    );
  });

  it("unescapes newlines and LaTeX backslashes", () => {
    expect(extractStreamingAnswer('{"answer":"Line one\\nUse $\\\\frac{1}{2}$')).toBe(
      "Line one\nUse $\\frac{1}{2}$",
    );
  });

  it("falls back to the last safe boundary on a half-arrived escape", () => {
    expect(extractStreamingAnswer('{"answer":"Nearly there\\u00e')).toBe(
      "Nearly there"
    );
  });

  it("tolerates whitespace around the key", () => {
    expect(extractStreamingAnswer('{ "answer" : "Spaced out')).toBe("Spaced out");
  });

  it("ignores a document whose answer field has not appeared yet", () => {
    expect(extractStreamingAnswer('{"sourceRefs":["S1"],"usedCurrentContext":true')).toBe(
      ""
    );
  });
});

/**
 * Read from a finished stream: the answer counts as whole only once its
 * closing quote arrived, whatever happened to the fields after it.
 */
describe("readCompletedStreamingAnswer", () => {
  it("returns the answer once its string has closed, even if the object never did", () => {
    expect(readCompletedStreamingAnswer('{"answer":"All done.","sourceRefs":["S')?.answer).toBe("All done.");
  });

  it("returns null for an answer cut off mid-string", () => {
    expect(readCompletedStreamingAnswer('{"answer":"Photosynthesis is')).toBeNull();
    expect(readCompletedStreamingAnswer('{"answer":"She said \\"go')).toBeNull();
  });

  it("returns null when there is no answer field", () => {
    expect(readCompletedStreamingAnswer('{"sourceRefs":[]}')).toBeNull();
  });

  it("unescapes a whole answer ending in LaTeX, which the live reading holds back", () => {
    expect(readCompletedStreamingAnswer('{"answer":"Use \\\\times"}')?.answer).toBe("Use \\times");
    expect(readCompletedStreamingAnswer('{"answer":"Use \\times"}')?.answer).toBe("Use \\times");
  });

  it("closes the document after each whole field from the answer on, latest first", () => {
    const readings = readCompletedStreamingAnswer(
      '{"memory":[],"answer":"x = 4","sourceRefs":["S1"],"usedCurrentContext":true,"graphs":["[]","[]","[]'
    )?.closedReadings;
    expect(readings).toEqual([
      '{"memory":[],"answer":"x = 4","sourceRefs":["S1"],"usedCurrentContext":true}',
      '{"memory":[],"answer":"x = 4","sourceRefs":["S1"]}',
      '{"memory":[],"answer":"x = 4"}',
    ]);
    readings?.forEach((reading) => expect(() => JSON.parse(reading)).not.toThrow());
  });

  it("ends with the whole object when it closed", () => {
    expect(readCompletedStreamingAnswer('{"answer":"a, b","sourceRefs":[]}')?.closedReadings[0]).toBe(
      '{"answer":"a, b","sourceRefs":[]}'
    );
  });
});

describe("the reply after its answer", () => {
  it("is nothing until the answer closes", () => {
    expect(readStreamingAnswerTail('{"answer":"Still going')).toBeNull();
    expect(readStreamingAnswerTail('{"answer":"Done.", "sourceRefs": []')).toBe(', "sourceRefs": []');
  });

  it("is a runaway once the same item repeats, as measured on the worker model", () => {
    expect(isRunawayAnswerTail(', "graphs": [ "[]", "[]" ] }')).toBe(false);
    expect(isRunawayAnswerTail(`, "graphs": [ ${Array(6).fill('"[]"').join(" , ")}`)).toBe(true);
    expect(isRunawayAnswerTail(`, "graphs": [ ${Array(6).fill('"The product rule, with an example"').join(", ")}`)).toBe(
      true
    );
    expect(isRunawayAnswerTail(`, "sourceRefs": [${Array(6).fill("[]").join(",")}`)).toBe(true);
  });

  it("is a runaway once it is far longer than any real set of fields", () => {
    expect(isRunawayAnswerTail(`, "graphs": ["${"x".repeat(9_000)}`)).toBe(true);
  });
});
