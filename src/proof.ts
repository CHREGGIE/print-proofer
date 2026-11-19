import Anthropic from "@anthropic-ai/sdk";

export type Severity = "error" | "warning" | "suggestion";

export interface Issue {
  severity: Severity;
  category: string;
  original: string;
  suggestion: string;
  explanation: string;
  location: string;
}

export interface ProofResult {
  transcription: string;
  summary: string;
  issues: Issue[];
  corrected_text: string;
}

export interface ProofImage {
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  base64: string;
}

const MODEL = "claude-opus-5-5";

const SYSTEM_PROMPT = `You are a meticulous professional print proofreader. The user is about to send a piece of print or digital material (flyer, business card, sign, menu, brochure, ad, social post, invitation, email, etc.) to print or publish, and wants every mistake caught first. A missed error costs them a reprint, so be thorough. Equally, do not flag things that are fine: a false alarm wastes their time.

Work from the image(s) and/or text provided. First transcribe all visible text faithfully, exactly as printed (keep the mistakes; do not silently fix anything in the transcription). Preserve reading order and use line breaks between separate text blocks. If several images are given, treat them as pages of one piece and label them "[Page 1]", "[Page 2]", etc.

Then check for:
- spelling: misspellings, typos, doubled words, wrong homophones (their/there, your/you're, its/it's)
- grammar: agreement, tense, missing or extra words, sentence fragments that read as mistakes
- punctuation: missing or stray marks, apostrophe misuse (e.g. plural "Taco's"), unbalanced quotes or brackets, inconsistent use of serial comma or end punctuation across list items
- capitalization: inconsistent title case or headings, proper nouns
- consistency: the same name, word, number, price, phone, date or time written differently in different places; mixed formats (e.g. "5pm" vs "5:00 PM")
- facts that can be checked internally: a weekday that does not match the date (use the calendar for the stated or most likely year), totals that do not add up, impossible dates or times, phone numbers with the wrong number of digits, malformed emails or web addresses
- formatting and layout as visible in the image: text cut off or too close to the edge, inconsistent spacing or alignment, widows/orphans, text hard to read against the background
- clarity and style: awkward or confusing wording, unclear call to action (lower severity)

Severity:
- "error": a definite mistake that should be fixed before printing
- "warning": very likely a mistake, or something the user must double-check (e.g. a date/weekday mismatch, an unusual spelling of a name)
- "suggestion": optional improvement in style, clarity or layout

For each issue, "original" must be copied exactly, character for character, from your transcription so it can be highlighted; keep it short (just the word or phrase). "suggestion" is the corrected text (or, for layout issues, what to change). "location" says where it appears (e.g. "headline", "page 2, bottom-left"). "explanation" is one short plain-English sentence.

Respect intentional brand names, stylized logos, slang, and deliberate stylistic choices; mention them only if they look inconsistent. If the user gives notes (correct spellings of names, house style, etc.), treat them as authoritative.

"corrected_text" is the full transcription with all errors and warnings fixed (not optional suggestions). "summary" is one or two sentences giving the overall verdict, e.g. "3 errors to fix before printing: ...", or "Looks clean - no errors found." If an image is too blurry to read some text, say so in the summary and mark unreadable spots in the transcription as [unreadable].`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["transcription", "summary", "issues", "corrected_text"],
  properties: {
    transcription: { type: "string" },
    summary: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "category", "original", "suggestion", "explanation", "location"],
        properties: {
          severity: { type: "string", enum: ["error", "warning", "suggestion"] },
          category: {
            type: "string",
            enum: [
              "spelling",
              "grammar",
              "punctuation",
              "capitalization",
              "consistency",
              "facts",
              "formatting",
              "clarity",
            ],
          },
          original: { type: "string" },
          suggestion: { type: "string" },
          explanation: { type: "string" },
          location: { type: "string" },
        },
      },
    },
    corrected_text: { type: "string" },
  },
} as const;

export class ProofError extends Error {}

export async function proofread(opts: {
  apiKey: string;
  images: ProofImage[];
  text: string;
  notes: string;
  signal?: AbortSignal;
}): Promise<ProofResult> {
  const { apiKey, images, text, notes, signal } = opts;

  const client = new Anthropic({
    apiKey,
    // This app runs only on your own device with your own key.
    dangerouslyAllowBrowser: true,
  });

  const content: Anthropic.Beta.BetaContentBlockParam[] = images.map((img) => ({
    type: "image",
    source: { type: "base64", media_type: img.mediaType, data: img.base64 },
  }));

  const today = new Date().toDateString();
  let instruction = `Proofread this before it goes to print. Today's date is ${today}.`;
  if (text.trim()) instruction += `\n\nText to proofread:\n"""\n${text.trim()}\n"""`;
  if (notes.trim()) instruction += `\n\nNotes from the user (authoritative):\n${notes.trim()}`;
  content.push({ type: "text", text: instruction });

  let message: Anthropic.Beta.BetaMessage;
  try {
    const stream = client.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: 32000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: {
          effort: "high",
          format: { type: "json_schema", schema: SCHEMA as unknown as Record<string, unknown> },
        },
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content }],
      },
      { signal },
    );
    message = await stream.finalMessage();
  } catch (err) {
    throw new ProofError(describeError(err));
  }

  if (message.stop_reason === "refusal") {
    throw new ProofError("Claude declined to check this one. Try a different image or crop.");
  }
  if (message.stop_reason === "max_tokens") {
    throw new ProofError("This piece has too much text for one check. Try splitting it into smaller photos.");
  }

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new ProofError("No result came back. Please try again.");
  }
  try {
    return JSON.parse(textBlock.text) as ProofResult;
  } catch {
    throw new ProofError("The result could not be read. Please try again.");
  }
}

export interface VideoInsights {
  summary: string;
  tools: string[];
  prompts: string[];
  prices: string[];
  offers: string[];
  links: string[];
}

const VIDEO_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "tools", "prompts", "prices", "offers", "links"],
  properties: {
    summary: { type: "string" },
    tools: { type: "array", items: { type: "string" } },
    prompts: { type: "array", items: { type: "string" } },
    prices: { type: "array", items: { type: "string" } },
    offers: { type: "array", items: { type: "string" } },
    links: { type: "array", items: { type: "string" } },
  },
};

/** Optional Claude pass over text OCR'd from video frames (timestamps included). */
export async function summarizeVideoText(apiKey: string, timedText: string, signal?: AbortSignal): Promise<VideoInsights> {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  let message: Anthropic.Beta.BetaMessage;
  try {
    message = await client.beta.messages
      .stream(
        {
          model: MODEL,
          max_tokens: 16000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: "medium", format: { type: "json_schema", schema: VIDEO_SCHEMA } },
          system:
            "You receive text read by OCR from frames of a video (tutorial, ad or promo), one line per piece of on-screen text, each with its timestamp. OCR may contain small errors; fix obvious ones. Extract: tools, apps, products and brand names shown; prompts or commands typed on screen (verbatim, merged across frames); prices (with what they are for); offers, discounts, promo codes and deadlines; links and handles. Include the timestamp in parentheses after each item, e.g. \"Notion AI (0:42)\". summary: 2-3 sentences on what the video shows and its key on-screen takeaways. Use empty arrays when nothing applies.",
          messages: [{ role: "user", content: timedText.slice(0, 150000) }],
        },
        { signal },
      )
      .finalMessage();
  } catch (err) {
    throw new ProofError(describeError(err));
  }
  if (message.stop_reason === "refusal") throw new ProofError("Claude declined to summarize this video's text.");
  const block = message.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new ProofError("No summary came back. Please try again.");
  try {
    return JSON.parse(block.text) as VideoInsights;
  } catch {
    throw new ProofError("The summary could not be read. Please try again.");
  }
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.APIUserAbortError) return "Cancelled.";
  if (err instanceof Anthropic.AuthenticationError)
    return "Your API key was rejected. Check it in Settings.";
  if (err instanceof Anthropic.PermissionDeniedError)
    return "This API key isn't allowed to use this model. Check your Anthropic Console account.";
  if (err instanceof Anthropic.RateLimitError)
    return "Too many requests (or out of API credit). Wait a minute and try again, or check billing in the Anthropic Console.";
  if (err instanceof Anthropic.BadRequestError) return `The request was rejected: ${err.message}`;
  if (err instanceof Anthropic.InternalServerError)
    return "Claude's servers had a problem. Try again in a moment.";
  if (err instanceof Anthropic.APIConnectionError)
    return "Couldn't reach Claude. Check your internet connection.";
  if (err instanceof Anthropic.APIError) return `Error ${err.status ?? ""}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
