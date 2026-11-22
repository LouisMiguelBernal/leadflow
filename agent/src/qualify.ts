import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Lead } from "./db.js";

// Resolves ANTHROPIC_API_KEY from the environment. Never hardcode the key.
const client = new Anthropic();

export const MODEL = "claude-opus-5";

/**
 * The contract between the model and the rest of the system.
 *
 * Structured outputs matter more here than they look: n8n branches on `score`
 * and the dashboard renders `reasoning`. If the model were free to answer in
 * prose, every downstream consumer would need its own parser, and each one
 * would break differently on a bad day.
 */
const Verdict = z.object({
  score: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe("0-100 fit score. Be decisive; avoid clustering around 50."),
  reasoning: z
    .string()
    .describe("Two or three sentences a salesperson can act on. No preamble."),
  recommended_action: z.enum(["review", "reject"]),
  disqualifiers: z
    .array(z.string())
    .describe("Concrete reasons this is a poor fit. Empty if none."),
});

export type Verdict = z.infer<typeof Verdict>;

// Kept as a module constant rather than built per request: a stable prefix is
// what makes prompt caching possible later, and it keeps the scoring rubric
// reviewable in one place instead of buried in string interpolation.
const SYSTEM = `You qualify inbound B2B leads for a small automation consultancy.

Score for fit, not politeness:
- 80-100  clear budget signal, a named problem, and a real company
- 50-79   plausible fit but missing budget, timeline, or specifics
- 20-49   vague interest, student or hobbyist, or wrong service entirely
- 0-19    spam, a sales pitch aimed at us, or an empty message

Recommend "reject" only for scores under 20. Everything else goes to a human.
Judge only what the message actually says. Do not invent context.`;

export async function qualifyLead(lead: Lead): Promise<Verdict> {
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM,
    // Lead scoring is a short classification task, so the extra thinking depth
    // of the default ("high") buys nothing. Raise this if scores drift.
    output_config: {
      effort: "low",
      format: zodOutputFormat(Verdict),
    },
    messages: [
      {
        role: "user",
        content: [
          `Name: ${lead.full_name ?? "(not given)"}`,
          `Email: ${lead.email}`,
          `Company: ${lead.company ?? "(not given)"}`,
          `Message: ${lead.message ?? "(empty)"}`,
        ].join("\n"),
      },
    ],
  });

  // parsed_output is null when the model stops early — max_tokens, or a
  // refusal. Treat that as a failure rather than shipping a partial verdict.
  if (!response.parsed_output) {
    throw new Error(
      `model returned no parsed verdict (stop_reason: ${response.stop_reason})`,
    );
  }

  return response.parsed_output;
}
