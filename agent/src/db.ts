import pg from "pg";

// One pool for the process. Creating a Client per request exhausts Postgres
// connections under any real load.
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export type LeadStatus =
  | "new"
  | "qualifying"
  | "awaiting_review"
  | "approved"
  | "rejected"
  | "paid";

export interface Lead {
  id: string;
  email: string;
  full_name: string | null;
  company: string | null;
  message: string | null;
  status: LeadStatus;
  score: number | null;
  reasoning: string | null;
}

export async function getLead(id: string): Promise<Lead | null> {
  const { rows } = await pool.query<Lead>(
    `SELECT id, email, full_name, company, message, status, score, reasoning
       FROM leads WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function createLead(input: {
  email: string;
  full_name?: string | null;
  company?: string | null;
  message?: string | null;
  source?: string;
}): Promise<Lead> {
  const { rows } = await pool.query<Lead>(
    `INSERT INTO leads (email, full_name, company, message, source)
     VALUES ($1, $2, $3, $4, COALESCE($5, 'webhook'))
     RETURNING id, email, full_name, company, message, status, score, reasoning`,
    [
      input.email,
      input.full_name ?? null,
      input.company ?? null,
      input.message ?? null,
      input.source ?? null,
    ],
  );
  return rows[0]!;
}

export async function recordEvent(
  leadId: string,
  kind: string,
  actor: string,
  detail: unknown = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO lead_events (lead_id, kind, actor, detail)
     VALUES ($1, $2, $3, $4)`,
    [leadId, kind, actor, JSON.stringify(detail)],
  );
}

/**
 * Writes the agent's verdict and advances the lead's status, then records the
 * audit event — both in one transaction, so a lead can never show a score
 * with no matching event explaining where it came from.
 */
export async function saveVerdict(
  leadId: string,
  verdict: {
    score: number;
    reasoning: string;
    model: string;
    nextStatus: Extract<LeadStatus, "awaiting_review" | "rejected">;
  },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE leads
          SET score = $2, reasoning = $3, agent_model = $4, status = $5
        WHERE id = $1`,
      [leadId, verdict.score, verdict.reasoning, verdict.model, verdict.nextStatus],
    );
    await client.query(
      `INSERT INTO lead_events (lead_id, kind, actor, detail)
       VALUES ($1, 'qualified', 'agent', $2)`,
      [
        leadId,
        JSON.stringify({
          score: verdict.score,
          model: verdict.model,
          status: verdict.nextStatus,
        }),
      ],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
