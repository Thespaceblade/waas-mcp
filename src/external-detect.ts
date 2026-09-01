const EXTERNAL_PATTERNS: { type: string; pattern: RegExp }[] = [
  { type: "email", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { type: "greenhouse", pattern: /greenhouse\.io\/[^/\s]+/i },
  { type: "lever", pattern: /jobs\.lever\.co\/[^/\s]+/i },
  { type: "ashby", pattern: /jobs\.ashbyhq\.com\/[^/\s]+/i },
  { type: "workday", pattern: /myworkdayjobs\.com/i },
  { type: "linkedin", pattern: /linkedin\.com\/jobs\//i },
];

export type ExternalApplyHint = {
  detected: boolean;
  type: string | null;
  match: string | null;
  instructions: string | null;
};

export function detectExternalApply(text: string): ExternalApplyHint {
  const plain = text.replace(/<[^>]+>/g, " ");
  for (const { type, pattern } of EXTERNAL_PATTERNS) {
    const match = plain.match(pattern);
    if (match) {
      return {
        detected: true,
        type,
        match: match[0],
        instructions:
          type === "email"
            ? `Apply via email: ${match[0]}`
            : `Apply externally via ${type}: ${match[0]}`,
      };
    }
  }

  if (/\bapply (on|at|via) our (website|careers page)\b/i.test(plain)) {
    return {
      detected: true,
      type: "website",
      match: null,
      instructions: "Job description references an external careers page.",
    };
  }

  if (/\bmessage (the )?founder\b/i.test(plain) || /\bemail us\b/i.test(plain)) {
    return {
      detected: true,
      type: "instructions",
      match: null,
      instructions: "Job description includes informal apply instructions — read carefully.",
    };
  }

  return { detected: false, type: null, match: null, instructions: null };
}
