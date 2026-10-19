import { describe, expect, it } from "vitest";
import {
  attachInlineMathPunctuation,
  normalizeLegacyJamiMathText,
  normalizeMathDelimiters,
  prepareAiMarkdown,
  preprocessMathDelimiters,
  readFencedBlockAsMath,
  readInlineCodeAsMath,
  splitMathRichText,
  wrapBareLatex,
} from "@/lib/study/math-text";

/**
 * Marking reports quote maths as the scheme wrote it, and a scheme extracted
 * from a PDF often has no delimiters -- so students read
 * `\begin{pmatrix} 4 \\ -3 \end{pmatrix}` instead of a column vector.
 */
describe("wrapping LaTeX written without delimiters", () => {
  it("wraps a whole environment, so a column vector renders", () => {
    expect(wrapBareLatex("Answer: \\begin{pmatrix} 4 \\\\ -3 \\end{pmatrix}")).toBe(
      "Answer: $\\begin{pmatrix} 4 \\\\ -3 \\end{pmatrix}$"
    );
  });

  it("wraps a single command with its arguments", () => {
    expect(wrapBareLatex("\\frac{3}{4} of the total")).toBe("$\\frac{3}{4}$ of the total");
  });

  it("wraps a whole bare formula as one, not a command at a time", () => {
    expect(
      wrapBareLatex("The Laplace transform is \\mathcal{L}\\{f(t)\\} = \\int_0^\\infty e^{-st} f(t)\\,dt.")
    ).toBe("The Laplace transform is $\\mathcal{L}\\{f(t)\\} = \\int_0^\\infty e^{-st} f(t)\\,dt$.");
    expect(wrapBareLatex("25 \\div 10 (= 2.5)")).toBe("$25 \\div 10 (= 2.5)$");
    expect(wrapBareLatex("so x = \\sqrt{2} and y = 3")).toBe("so $x = \\sqrt{2}$ and y = 3");
  });

  it("leaves a bracket the formula never opened to the sentence", () => {
    expect(wrapBareLatex("(see \\alpha)")).toBe("(see $\\alpha$)");
    expect(wrapBareLatex("where \\lambda is the rate, and")).toBe("where $\\lambda$ is the rate, and");
  });

  it("keeps a \\left...\\right pair together", () => {
    expect(wrapBareLatex("\\left( \\frac{1}{2} \\right) squared")).toBe(
      "$\\left( \\frac{1}{2} \\right)$ squared"
    );
  });

  it("leaves maths that already has delimiters as it was", () => {
    expect(wrapBareLatex("$\\frac{1}{2}$ and \\pi")).toBe("$\\frac{1}{2}$ and $\\pi$");
    expect(wrapBareLatex("$$x^2$$")).toBe("$$x^2$$");
  });

  it("leaves plain text alone", () => {
    expect(wrapBareLatex("Add 3 and 4 to get 7, costing $5")).toBe("Add 3 and 4 to get 7, costing $5");
  });
});

describe("math-rich study text", () => {
  it("separates inline and display TeX without exposing delimiters", () => {
    expect(
      splitMathRichText(
        "Evaluate $\\int_{0}^{2} x^2\\,dx = \\frac{8}{3}$.\n$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$"
      )
    ).toEqual([
      { type: "text", value: "Evaluate " },
      {
        type: "math",
        value: "\\int_{0}^{2} x^2\\,dx = \\frac{8}{3}",
        display: false,
      },
      { type: "text", value: ".\n" },
      {
        type: "math",
        value: "\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}",
        display: true,
      },
    ]);
  });

  it("supports parenthesized TeX and leaves ordinary currency alone", () => {
    expect(
      splitMathRichText("The fee is $5. Use \\(x^2 + y^2\\) here.")
    ).toEqual([
      { type: "text", value: "The fee is $5. Use " },
      { type: "math", value: "x^2 + y^2", display: false },
      { type: "text", value: " here." },
    ]);
  });

  it("falls back to plain text when delimiters are unbalanced", () => {
    expect(splitMathRichText("Use $\\frac{1}{3} without a closer")).toEqual([
      { type: "text", value: "Use $\\frac{1}{3} without a closer" },
    ]);
  });

  it("cleans sizing-command remnants from older saved assistant replies", () => {
    expect(
      normalizeLegacyJamiMathText("x³ Bigl {0}^{2} and Bigl(x + 1 Bigr)")
    ).toBe("x³ evaluated from 0 to 2 and (x + 1 )");
  });

  it("keeps punctuation attached to an inline equation", () => {
    expect(
      attachInlineMathPunctuation(
        splitMathRichText("Use $x^{n+1}/(n+1) + C$, where $n \\ne -1$.")
      )
    ).toEqual([
      { type: "text", value: "Use " },
      {
        type: "math",
        value: "x^{n+1}/(n+1) + C",
        display: false,
        trailingPunctuation: ",",
      },
      { type: "text", value: " where " },
      {
        type: "math",
        value: "n \\ne -1",
        display: false,
        trailingPunctuation: ".",
      },
      { type: "text", value: "" },
    ]);
  });
});

describe("normalizeMathDelimiters", () => {
  it("converts parenthesised inline math to dollar delimiters", () => {
    expect(normalizeMathDelimiters("Use \\(x^2 + y^2\\) here.")).toBe(
      "Use $x^2 + y^2$ here."
    );
  });

  it("converts bracketed display math to multi-line dollar delimiters", () => {
    expect(normalizeMathDelimiters("\\[a^2 + b^2 = c^2\\]")).toBe(
      "$$\na^2 + b^2 = c^2\n$$"
    );
  });

  it("converts single-line display math to multi-line display math", () => {
    expect(normalizeMathDelimiters("$$\\sum_{i=1}^{n} i$$")).toBe(
      "$$\n\\sum_{i=1}^{n} i\n$$"
    );
  });

  it("keeps existing inline math delimiters", () => {
    expect(normalizeMathDelimiters("The value is $x^2$.")).toBe(
      "The value is $x^2$."
    );
  });

  it("handles multiple math blocks", () => {
    expect(
      normalizeMathDelimiters("Inline \\(x\\) and display \\[y\\] plus $$z$$")
    ).toBe("Inline $x$ and display $\\displaystyle y$ plus \n\n$$\nz\n$$");
  });

  it("starts a display after words on its line in a paragraph of its own", () => {
    // "$$" mid-line is not read as maths: the student saw "$$ 0 \times A = 0." as written.
    expect(normalizeMathDelimiters("By the law, \\[0 \\times A = 0\\].")).toBe(
      "By the law, \n\n$$\n0 \\times A = 0.\n$$"
    );
  });

  it("leaves two prices as prices, and still finds the maths after them", () => {
    expect(normalizeMathDelimiters("It costs $5 and $10, but $x$ is unknown.")).toBe(
      "It costs \\$5 and \\$10, but $x$ is unknown."
    );
    expect(normalizeMathDelimiters("It costs $5 and $x$ is unknown.")).toBe(
      "It costs \\$5 and $x$ is unknown."
    );
    expect(splitMathRichText("$5 and $10")).toEqual([{ type: "text", value: "$5 and $10" }]);
  });

  it("keeps a display that shares its line with words on that line, at display size", () => {
    expect(normalizeMathDelimiters("Hence $$y = 3$$ as required.")).toBe(
      "Hence $\\displaystyle y = 3$ as required."
    );
    expect(normalizeMathDelimiters("$$x = 1$$ so done.")).toBe("$\\displaystyle x = 1$ so done.");
    expect(normalizeMathDelimiters("1. First $$x = 2$$\n2. Second")).toBe(
      "1. First $\\displaystyle x = 2$\n2. Second"
    );
  });

  it("takes a closing full stop inside the display, and leaves a list item's display as a display", () => {
    expect(normalizeMathDelimiters("Solve:\n\n$$x^2 = 4$$.")).toBe("Solve:\n\n$$\nx^2 = 4.\n$$");
    expect(normalizeMathDelimiters("- $$a = b$$")).toBe("- $$\na = b\n$$");
  });

  it("preserves text without math", () => {
    expect(normalizeMathDelimiters("Just plain text.")).toBe("Just plain text.");
  });
});

describe("preprocessMathDelimiters", () => {
  it("normalises math outside code blocks but leaves code blocks untouched", () => {
    const input = "$$x$$\n```\n$$y$$\n```\n\\(z\\)";
    const output = preprocessMathDelimiters(input);
    expect(output).toContain("$$\nx\n$$");
    expect(output).toContain("```\n$$y$$\n```");
    expect(output).toContain("$z$");
  });

  it("leaves inline code untouched", () => {
    const input = "Use `$x^2$` as a literal";
    expect(preprocessMathDelimiters(input)).toBe(input);
  });

  it("reads maths in backticks as maths, and code as code", () => {
    expect(readInlineCodeAsMath("$v = u + at$")).toBe("v = u + at");
    expect(readInlineCodeAsMath("\\frac{1}{2}mv^2")).toBe("\\frac{1}{2}mv^2");
    expect(readInlineCodeAsMath("x^2 - 4")).toBe("x^2 - 4");
    for (const code of ["console.log", 'print("\\n")', "snake_case", "$HOME", "$a + $b", "a ^= b;"]) {
      expect(readInlineCodeAsMath(code), code).toBeNull();
    }
  });

  it("reads a latex fence as maths and a python fence as code", () => {
    expect(readFencedBlockAsMath("```latex\n\\int_0^1 x\\,dx\n```")).toBe("\\int_0^1 x\\,dx");
    expect(readFencedBlockAsMath("```\n$$a^2 + b^2$$\n```")).toBe("a^2 + b^2");
    expect(readFencedBlockAsMath("```python\nx = 2 ** 3\n```")).toBeNull();
    expect(readFencedBlockAsMath("```\nx = 2\n```")).toBeNull();
  });

  it("prepares a reply: repairs its LaTeX, and leaves real code alone", () => {
    const repair = (value: string) => value.replace(/\\imes/g, "\\times");
    expect(prepareAiMarkdown("So $3 \\imes 4$, and `x^2`.", repair)).toBe("So $3 \\times 4$, and $x^2$.");
    const code = "```js\nconst price = `$${cost}`;\n```";
    expect(prepareAiMarkdown(code, repair)).toBe(code);
  });

  it("keeps display maths on its line when it sits in a table row", () => {
    expect(normalizeMathDelimiters("| Area | $$\\pi r^2$$ |")).toBe(
      "| Area | $\\displaystyle \\pi r^2$ |"
    );
  });

  it("still converts display math in the surrounding text", () => {
    expect(preprocessMathDelimiters("\\[a + b\\]")).toBe("$$\na + b\n$$");
  });

  it("leaves tilde-fenced code blocks untouched", () => {
    const input = "$$x$$\n~~~\n$$y$$\n~~~\n\\(z\\)";
    const output = preprocessMathDelimiters(input);
    expect(output).toContain("$$\nx\n$$");
    expect(output).toContain("~~~\n$$y$$\n~~~");
    expect(output).toContain("$z$");
  });
});
