export type MathRichTextSegment =
  | { type: "text"; value: string }
  | { type: "math"; value: string; display: boolean };

export type MathRichDisplaySegment = MathRichTextSegment & {
  trailingPunctuation?: string;
};

const MATH_DELIMITER_PATTERN =
  /\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)|\$\$([\s\S]*?)\$\$|\$([^$\n]+?)\$/g;

export function normalizeLegacyJamiMathText(text: string) {
  return text
    .replace(
      /\b(?:Bigl|Bigr|bigl|bigr|Bigm|bigm)\s*(?:\|\s*)?\{([^{}\n]+)\}\^\{([^{}\n]+)\}/g,
      "evaluated from $1 to $2"
    )
    .replace(/\b(?:Bigl|Bigr|bigl|bigr|Bigm|bigm)\b\s*/g, "");
}

/**
 * Two prices, not maths: "$5 and $10". Read as a pair, everything between the
 * dollars became one formula, and maths ignores spaces, so the student saw
 * "5and10" -- or, with a bold phrase or a command between them, a run of words
 * with no spaces and the stars and backslashes printed as they were written. A
 * closing dollar right before a digit opens the next price; a pair that starts
 * with a digit and ends in a space is a price and the words after it.
 */
function isCurrencyPair(text: string, match: RegExpExecArray) {
  const inline = match[4];
  if (inline === undefined) return false;
  const after = text[match.index + match[0].length] ?? "";
  return /\d/.test(after) || (/^\d/.test(inline) && /\s$/.test(inline));
}

type MathDelimiterMatch =
  | { kind: "math"; index: number; match: RegExpExecArray }
  /** A dollar that opens a price, not maths. */
  | { kind: "currency"; index: number };

/**
 * Every maths delimiter in the text, in order, for the splitter and the
 * Markdown preparation alike, so the two can never disagree about what is
 * maths. An escaped delimiter is skipped, and a price is reported so the search
 * carries on from the dollar after it: in "$5 and $x$" the maths is `$x$`.
 */
function* mathDelimiterMatches(text: string): Generator<MathDelimiterMatch> {
  const pattern = new RegExp(MATH_DELIMITER_PATTERN.source, "g");
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const { index } = match;
    if (index > 0 && text[index - 1] === "\\") {
      pattern.lastIndex = index + 1;
      continue;
    }
    if (isCurrencyPair(text, match)) {
      yield { kind: "currency", index };
      pattern.lastIndex = index + 1;
      continue;
    }
    yield { kind: "math", index, match };
  }
}

export function splitMathRichText(text: string): MathRichTextSegment[] {
  if (!text) return [{ type: "text", value: "" }];

  const segments: MathRichTextSegment[] = [];
  let cursor = 0;

  for (const found of mathDelimiterMatches(text)) {
    if (found.kind === "currency") continue;
    const { index, match } = found;

    const value = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (!value) continue;

    if (index > cursor) {
      segments.push({ type: "text", value: text.slice(cursor, index) });
    }
    segments.push({
      type: "math",
      value,
      display: match[1] !== undefined || match[3] !== undefined,
    });
    cursor = index + match[0].length;
  }

  if (cursor < text.length) {
    segments.push({ type: "text", value: text.slice(cursor) });
  }

  return segments.length > 0 ? segments : [{ type: "text", value: text }];
}

/**
 * Whether the text contains at least one balanced maths expression.
 *
 * Deliberately implemented on top of splitMathRichText so detection can never
 * disagree with rendering: an unbalanced `$` or a bare price like "$5" is not
 * treated as maths, exactly as the splitter treats it.
 */
export function hasMathDelimiters(text: string): boolean {
  if (!text || !/[$\\]/.test(text)) return false;
  return splitMathRichText(text).some((segment) => segment.type === "math");
}

/*
 * One piece of LaTeX written without delimiters: a whole environment, a
 * \left...\right pair, or a single command with its arguments and any script
 * straight after it. Environments and pairs are matched whole, because wrapping
 * their halves separately gives KaTeX a \left with no \right.
 */
const BARE_LATEX_PATTERN =
  /\\begin\{([a-zA-Z*]+)\}[\s\S]*?\\end\{\1\}|\\left[\s\S]*?\\right\s*(?:\\[a-zA-Z]+|\\?[^\sa-zA-Z])|\\[a-zA-Z]+(?:\s*\{(?:[^{}]|\{[^{}]*\})*\})*(?:\s*[\^_](?:\{[^{}]*\}|[A-Za-z0-9]))?/g;

/**
 * LaTeX that arrived without delimiters, wrapped so it renders.
 *
 * Marking reports and mark schemes quote maths as it was written, and a scheme
 * extracted from a PDF or a marker copying it often drops the `$`. The result
 * reached students as `\begin{pmatrix} 4 \\ -3 \end{pmatrix}` rather than as a
 * column vector. Only text outside existing delimiters is touched, so maths
 * that was written properly is left exactly as it was.
 */
export function wrapBareLatex(text: string): string {
  if (!text || !/\\[a-zA-Z]/.test(text)) return text;
  return splitMathRichText(text)
    .map((segment) => {
      if (segment.type === "math") {
        return segment.display ? `$$${segment.value}$$` : `$${segment.value}$`;
      }
      return wrapBareFormulas(segment.value);
    })
    .join("");
}

/*
 * The pieces of a line of prose, for finding where a bare formula starts and
 * ends. A command is a seed; scripts, braces, escaped symbols, numbers and
 * operators are maths around it; a word stops the formula, unless it is a
 * one- or two-letter name such as x, dt or ln.
 */
const BARE_TOKEN_PATTERN = new RegExp(
  [
    `(?<seed>${BARE_LATEX_PATTERN.source})`,
    String.raw`(?<math>\\\\|\\[{}|,;:! ]|\{(?:[^{}\n]|\{[^{}\n]*\})*\}|[\^_]|\d+(?:\.\d+)?)`,
    String.raw`(?<op>[=+\-*/<>|()\[\],!'~])`,
    String.raw`(?<name>[A-Za-z]+)`,
    String.raw`(?<space>[ \t]+)`,
    String.raw`(?<stop>[\s\S])`,
  ].join("|"),
  "g"
);

/** Short words that are English rather than a variable's name. */
const SHORT_WORDS = new Set(
  "a i am an as at be by do go he if in is it me my no of on or so to up us we".split(" ")
);

/**
 * Wraps each bare formula whole: `\mathcal{L}\{f(t)\} = \int_0^\infty e^{-st}`
 * becomes one `$...$`, not a `$` round each command with the braces, scripts
 * and powers between them left as raw text -- which is how Tutor's undelimited
 * maths reached students as "\{f(t)\} = ^ e^{-st}".
 */
function wrapBareFormulas(text: string) {
  if (!/\\[a-zA-Z]/.test(text)) return text;
  const tokens = [...text.matchAll(BARE_TOKEN_PATTERN)].map((match) => {
    const groups = match.groups ?? {};
    const kind = groups.seed
      ? "seed"
      : groups.space
        ? "space"
        : groups.math || groups.op || (groups.name && groups.name.length <= 2 && !SHORT_WORDS.has(groups.name.toLowerCase()))
          ? "math"
          : "stop";
    return { kind, value: match[0], index: match.index ?? 0 };
  });

  let out = "";
  let at = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const seed = tokens[index];
    // `\\` before a command is a line break inside maths, not the start of one.
    if (seed.kind !== "seed" || text[seed.index - 1] === "\\") continue;
    let start = index;
    while (start > 0 && tokens[start - 1].kind !== "stop" && tokens[start - 1].index >= at) start -= 1;
    let end = index;
    while (end + 1 < tokens.length && tokens[end + 1].kind !== "stop") end += 1;
    // Spaces, commas and dangling signs at the edges belong to the sentence.
    while (start < index && (tokens[start].kind === "space" || /^[,=)\]]$/.test(tokens[start].value))) start += 1;
    while (end > index && (tokens[end].kind === "space" || /^[,=(\[]$/.test(tokens[end].value))) end -= 1;
    let from = tokens[start].index;
    let to = tokens[end].index + tokens[end].value.length;
    // So does a bracket the formula never opened or closed: "(see \alpha)".
    for (const [open, close] of [["(", ")"], ["[", "]"]] as const) {
      for (;;) {
        const formula = text.slice(from, to);
        const balance = count(formula, open) - count(formula, close);
        if (balance > 0 && formula.startsWith(open)) from += 1;
        else if (balance < 0 && formula.endsWith(close)) to -= 1;
        else break;
      }
    }
    out += `${text.slice(at, from)}$${text.slice(from, to).trim()}$`;
    at = to;
    index = end;
  }
  return out + text.slice(at);
}

function count(text: string, character: string) {
  return text.split(character).length - 1;
}

export function attachInlineMathPunctuation(
  input: readonly MathRichTextSegment[]
): MathRichDisplaySegment[] {
  const segments: MathRichDisplaySegment[] = input.map((segment) => ({
    ...segment,
  }));
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const next = segments[index + 1];
    if (segment.type !== "math" || segment.display || next.type !== "text") {
      continue;
    }
    const punctuation = next.value.match(/^[,.;:!?]/)?.[0];
    if (!punctuation) continue;
    segment.trailingPunctuation = punctuation;
    next.value = next.value.slice(punctuation.length);
  }
  return segments;
}

/**
 * Normalize math delimiters so that remark-math / rehype-katex can render them.
 *
 * - \( ... \) -> $...$  (inline)
 * - \[ ... \] -> multi-line $$...$$ (display)
 * - $$...$$   -> multi-line $$...$$ (display)
 *
 * Multi-line display math is required by remark-math v6 so that rehype-katex
 * wraps the output with the katex-display class.
 *
 * Note: this function does not protect Markdown code blocks or inline code.
 * Use preprocessMathDelimiters when working with raw Markdown.
 */
export function normalizeMathDelimiters(text: string): string {
  const result: string[] = [];
  let cursor = 0;

  for (const found of mathDelimiterMatches(text)) {
    if (found.kind === "currency") {
      // Escaped, so the Markdown maths reader cannot pair it either.
      result.push(text.slice(cursor, found.index), "\\$");
      cursor = found.index + 1;
      continue;
    }
    const { index, match } = found;

    result.push(text.slice(cursor, index));

    const display = match[1] ?? match[3];
    if (display !== undefined) {
      const end = index + match[0].length;
      const after = restOfLine(text, end);
      // Punctuation that closes the sentence goes inside the display, as
      // typeset maths has it; left after the closing $$ it stops the block
      // being read as maths at all.
      const closing = /^[.,;:]$/.test(after.trim()) ? after.trim() : "";
      // \[ ... \] and $$...$$ -> multi-line display math, except where a line
      // break would split something that has to stay on one line -- a table
      // row, "Hence $$y = 3$$ as required", a list item's words -- and so
      // the maths stays inline, at display size.
      if (
        isOnTableRow(text, index) ||
        (after.trim() && !closing) ||
        (isOnListItem(text, index) && hasTextBefore(text, index))
      ) {
        result.push(`$\\displaystyle ${display.trim().replace(/\s*\n\s*/g, " ")}$`);
      } else {
        // A display after words on its line starts a paragraph of its own:
        // "$$" in the middle of a line is not read as maths, and the student
        // saw "$$ 0 \times A = 0." printed as it was written.
        result.push(`${hasTextBefore(text, index) ? "\n\n" : ""}$$\n${display.trim()}${closing}\n$$`);
        cursor = end + after.length;
        continue;
      }
    } else if (match[2] !== undefined) {
      // \( ... \) -> inline math
      result.push(`$${match[2].trim()}$`);
    } else if (match[4] !== undefined) {
      // $...$ -> keep as inline math
      result.push(`$${match[4]}$`);
    }

    cursor = index + match[0].length;
  }

  result.push(text.slice(cursor));
  return result.join("");
}

/**
 * Whether words come before `index` on its line. A list marker or quote
 * marker does not count: "- $$a = b$$" is a display on a list item.
 */
function hasTextBefore(text: string, index: number) {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  return !/^\s*(?:>\s*)*(?:(?:[-*+]|\d{1,3}[.)])\s+)?$/.test(text.slice(lineStart, index));
}

/** Whether the character at `index` sits on a Markdown list item. */
function isOnListItem(text: string, index: number) {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  return /^\s*(?:>\s*)*(?:[-*+]|\d{1,3}[.)])\s/.test(text.slice(lineStart, index));
}

/** The rest of the line from `index`, up to but not including its newline. */
function restOfLine(text: string, index: number) {
  const lineEnd = text.indexOf("\n", index);
  return text.slice(index, lineEnd < 0 ? text.length : lineEnd);
}

/** Whether the character at `index` sits on a Markdown table row. */
function isOnTableRow(text: string, index: number) {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  return /^\s*\|/.test(text.slice(lineStart, index));
}

// Pattern that captures fenced code blocks, tilde code blocks, and inline code
// so that math normalisation can skip them.
const CODE_BLOCK_PATTERN = /(`{3,}[\s\S]*?`{3,}|~{3,}[\s\S]*?~{3,}|`[^`\n]*?`)/g;

/**
 * Like normalizeMathDelimiters, but leaves Markdown code blocks and inline
 * code untouched. This is the function the renderer should use on raw AI
 * output before handing it to react-markdown.
 */
export function preprocessMathDelimiters(text: string): string {
  const parts: { type: "text" | "code"; value: string }[] = [];
  let cursor = 0;

  for (const match of text.matchAll(CODE_BLOCK_PATTERN)) {
    const index = match.index ?? -1;
    if (index < 0) continue;
    if (index > cursor) {
      parts.push({ type: "text", value: text.slice(cursor, index) });
    }
    parts.push({ type: "code", value: match[0] });
    cursor = index + match[0].length;
  }

  if (cursor < text.length) {
    parts.push({ type: "text", value: text.slice(cursor) });
  }

  return parts
    .map((part) => (part.type === "code" ? part.value : normalizeMathDelimiters(part.value)))
    .join("");
}

/*
 * Commands only maths uses. Inline code holding one of these is maths the
 * model put in backticks by mistake. Code with a stray backslash -- a "\n" in
 * a Python string -- is not, because every name here must end at a non-letter.
 */
const MATH_COMMAND_PATTERN =
  /\\(?:frac|dfrac|tfrac|sqrt|times|cdot|div|pm|mp|leq?|geq?|neq|approx|equiv|propto|infty|int|iint|oint|sum|prod|lim|log|ln|exp|sin|cos|tan|sec|csc|cot|arcsin|arccos|arctan|sinh|cosh|tanh|alpha|beta|gamma|Gamma|delta|Delta|epsilon|varepsilon|eta|theta|Theta|kappa|lambda|Lambda|mu|xi|pi|Pi|rho|sigma|Sigma|tau|phi|Phi|varphi|chi|psi|Psi|omega|Omega|partial|nabla|vec|hat|bar|overline|underline|overrightarrow|text|mathrm|mathbf|mathit|mathbb|operatorname|left|right|begin|circ|degree|rightarrow|leftarrow|Rightarrow|Leftarrow|leftrightarrow|rightleftharpoons|mapsto|notin|subset|subseteq|cup|cap|emptyset|forall|exists|binom|therefore|because|angle|triangle|perp|parallel|ce|pu|quad|qquad|displaystyle|boxed|ldots|cdots)(?![a-zA-Z])/;

/** A piece of text that is nothing but delimited maths. */
const DELIMITED_MATH_PATTERN =
  /^(?:\$\$([\s\S]+)\$\$|\$([^$]+)\$|\\\(([\s\S]+)\\\)|\\\[([\s\S]+)\\\])$/;

/** Letters, numbers and arithmetic with a power in it: `x^2 + 3x`. */
const PLAIN_POWER_PATTERN = /^[A-Za-z0-9\s+\-*/=().,{}]*[A-Za-z0-9)}]\s*\^[A-Za-z0-9\s+\-*/=().,^{}]+$/;

function readDelimitedMath(value: string): string | null {
  const match = value.match(DELIMITED_MATH_PATTERN);
  if (!match) return null;
  const math = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").trim();
  return math && !math.includes("$") ? math : null;
}

/**
 * Maths a model wrapped in backticks, or null if it is really code.
 *
 * Models put an equation in inline code often enough -- `$v = u + at$`,
 * `\frac{1}{2}mv^2` -- and it reached students as monospace with its dollar
 * signs showing, in the code colour, which on the light theme is a red. Code
 * is only read as maths when it could not sensibly be anything else.
 */
export function readInlineCodeAsMath(code: string): string | null {
  const value = code.trim();
  if (!value) return null;
  if (value.startsWith("$") || value.startsWith("\\(") || value.startsWith("\\[")) {
    return readDelimitedMath(value);
  }
  if (value.includes("$")) return null;
  if (MATH_COMMAND_PATTERN.test(value)) return value;
  if (PLAIN_POWER_PATTERN.test(value)) return value;
  return null;
}

const MATH_FENCE_LANGUAGES = new Set(["latex", "tex", "math", "katex"]);

/**
 * A fenced block that is maths, as the maths inside it, or null if it is code.
 *
 * A `latex` or `math` fence is maths by its own label. An unlabelled one is
 * maths only when everything in it is already in maths delimiters.
 */
export function readFencedBlockAsMath(block: string): string | null {
  const fence = block.match(/^(`{3,}|~{3,})[ \t]*([^\s`~]*)[^\n]*\n([\s\S]*?)\n?[ \t]*\1[ \t]*$/);
  if (!fence) return null;
  const language = fence[2].toLowerCase();
  const body = fence[3].trim();
  if (!body) return null;
  const delimited = readDelimitedMath(body);
  if (MATH_FENCE_LANGUAGES.has(language)) return delimited ?? (body.includes("$") ? null : body);
  return language ? null : delimited;
}

/**
 * An AI reply, made ready for the Markdown renderer.
 *
 * Everything preprocessMathDelimiters does, plus what a reply needs before its
 * maths can render: LaTeX commands written with no delimiters, and maths put
 * in code by mistake. `repairLatex` is applied to everything that is not code,
 * for repairs that belong to the model rather than to Markdown. Real code is
 * left exactly as it was written.
 */
export function prepareAiMarkdown(
  text: string,
  repairLatex: (value: string) => string = (value) => value
): string {
  const parts: string[] = [];
  let cursor = 0;

  const pushProse = (value: string) => {
    if (value) parts.push(normalizeMathDelimiters(wrapBareLatex(repairLatex(value))));
  };

  for (const match of text.matchAll(CODE_BLOCK_PATTERN)) {
    const index = match.index ?? -1;
    if (index < 0) continue;
    pushProse(text.slice(cursor, index));
    const code = match[0];
    if (/^(?:`{3,}|~{3,})/.test(code)) {
      const math = readFencedBlockAsMath(code);
      parts.push(math ? `$$\n${repairLatex(math)}\n$$` : code);
    } else {
      const math = readInlineCodeAsMath(code.slice(1, -1));
      parts.push(math ? `$${repairLatex(math)}$` : code);
    }
    cursor = index + code.length;
  }
  pushProse(text.slice(cursor));

  return parts.join("");
}
