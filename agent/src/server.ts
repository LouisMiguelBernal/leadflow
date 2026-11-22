import express from "express";
import { z } from "zod";
import { createLead, getLead, pool, recordEvent, saveVerdict } from "./db.js";
import { MODEL, qualifyLead } from "./qualify.js";

const app = express();
app.use(express.json({ limit: "256kb" }));

// n8n hits this. Two shapes are accepted: a lead id for something already in
// the database, or the raw lead fields to create and qualify in one call.
const QualifyRequest = z.union([
  z.object({ leadId: z.string().uuid() }),
  z.object({
    email: z.string().email(),
    full_name: z.string().optional(),
    company: z.string().optional(),
    message: z.string().optional(),
    source: z.string().optional(),
  }),
]);

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, model: MODEL });
  } catch (err) {
    res.status(503).json({ ok: false, error: (err as Error).message });
  }
});

app.post("/qualify", async (req, res) => {
  const parsed = QualifyRequest.safeParse(req.body);
  if (!parsed.success) {
    // 400, not 500: the caller sent something wrong, and n8n should not retry
    // a request that will fail identically every time.
    return res.status(400).json({
      error: "invalid request body",
      detail: parsed.error.flatten(),
    });
  }

  let leadId: string;
  try {
    const lead =
      "leadId" in parsed.data
        ? await getLead(parsed.data.leadId)
        : await createLead(parsed.data);

    if (!lead) return res.status(404).json({ error: "lead not found" });
    leadId = lead.id;

    if (!("leadId" in parsed.data)) {
      await recordEvent(leadId, "received", "n8n", { source: lead.email });
    }

    const verdict = await qualifyLead(lead);

    await saveVerdict(leadId, {
      score: verdict.score,
      reasoning: verdict.reasoning,
      model: MODEL,
      nextStatus:
        verdict.recommended_action === "reject" ? "rejected" : "awaiting_review",
    });

    res.json({ leadId, ...verdict });
  } catch (err) {
    const message = (err as Error).message;
    console.error("qualify failed:", message);

    // Record the failure against the lead when we have one. A lead that got
    // stuck is worth seeing in the audit trail; a silent 500 is not.
    if (leadId!) {
      await recordEvent(leadId, "error", "agent", { message }).catch(() => {});
    }
    // 500 is deliberate — it tells n8n's retry logic this one is worth
    // another attempt, unlike the 400 above.
    res.status(500).json({ error: message });
  }
});

const port = Number(process.env.AGENT_PORT ?? 4000);
app.listen(port, () => {
  console.log(`agent → http://localhost:${port}  (model: ${MODEL})`);
});
