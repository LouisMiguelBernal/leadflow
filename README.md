# LeadFlow — lead-to-cash agent pipeline

An inbound lead is received, qualified by an AI agent, gated on a human
approval, then billed — with every state change recorded and reviewable.

```
inbound lead
  → n8n webhook            capture, validate, retry
  → agent service          Claude qualifies it: score + reasoning (structured output)
  → human approval         nothing bills without a person saying yes
  → Stripe                 checkout link, verified webhook
  → dashboard              the pipeline, live, with the audit trail
```

Built as a portfolio piece: it deliberately covers production n8n, agent tool
use with structured output, human-in-the-loop, Postgres schema design, a real
frontend on a real backend, and a deployment you can maintain.

---

## Running it

```bash
docker compose up -d
```

| Service | URL | Notes |
|---|---|---|
| n8n | http://localhost:5678 | shares the volume from `automation-lab`, so your account carried over |
| Adminer (DB browser) | http://localhost:8081 | server `postgres`, user `leadflow`, db `leadflow` |
| Postgres | `localhost:5434` | `postgres:5432` from inside a container |

Ports are shifted off the defaults because 5432/8000/8080 are taken by the
`pipeline` project on this machine.

Copy `env.example` to `.env` and fill it in before running the agent service:

```bash
Copy-Item env.example .env
```

### The localhost trap

`localhost` inside a container is the container. From an n8n node:

- Postgres → host `postgres`, port `5432`
- the agent service, run on the host via npm → `http://host.docker.internal:4000`

Getting this wrong produces `ECONNREFUSED` and about an hour of confusion.

---

## Schema

`db/migrations/` is mounted into Postgres's init directory, so the files run
**once, in filename order, on an empty data directory**. Editing them after the
first boot changes nothing. To re-apply:

```bash
docker compose down -v && docker compose up -d
```

(That destroys the data. Fine now; before there's anything worth keeping,
this moves to a real migration runner.)

| Table | Why it exists |
|---|---|
| `leads` | the record, with the agent's `score` / `reasoning` / `agent_model` |
| `lead_events` | append-only audit trail — answers "why did the system do that?" |
| `approvals` | the human gate; a partial unique index allows only one open request per lead |
| `payments` | `stripe_event_id UNIQUE` is what makes webhook handling idempotent |

Two decisions worth being able to defend in an interview:

- **`lead_status` is a database enum, not a string column.** Three different
  writers touch this table — n8n, the agent, the dashboard — so the constraint
  belongs where all three meet.
- **`payments.stripe_event_id` is `UNIQUE`.** Stripe retries for up to three
  days; the same event *will* arrive twice. A unique violation on insert is a
  correct, race-free "already handled" signal. A `SELECT … IF NOT EXISTS` check
  is not.

---

## Build order

- [x] **0 — Foundation.** Compose stack, Postgres schema, n8n on the same network.
- [x] **1 — Agent service.** Claude scores a lead via structured output and
      writes `leads` + `lead_events` in one transaction. Every path verified
      except the live model call, which needs `ANTHROPIC_API_KEY`.
- [ ] **1b — Tool calling.** Let the agent look up prior leads from the same
      company before scoring — the tool-use half of the job description.
- [ ] **2 — n8n intake workflow.** Webhook → validate → call agent → branch on
      score, with real error handling and retries. Exported to `n8n/workflows/`.
- [ ] **3 — Human approval.** Approve/reject from n8n, written to `approvals`.
- [ ] **4 — Stripe.** Checkout link on approval; verified webhook → `payments`.
      Port the working code from `E:\automation-lab\stripe-lab`.
- [ ] **5 — Dashboard.** Next.js over the pipeline and the audit trail.
- [ ] **6 — Deploy.** VPS, HTTPS, backups, monitoring.

---

## Repo layout

```
docker-compose.yml     postgres + n8n + adminer
db/migrations/         schema, applied on first boot
agent/                 qualification service (step 1)
web/                   dashboard (step 5)
n8n/workflows/         exported workflow JSON — version controlled, not
                       trapped inside the n8n database
docs/                  decisions and interview notes
```

Exporting workflows to `n8n/workflows/` matters: workflows that live only
inside n8n's own database can't be reviewed, diffed, or redeployed. That
answers "do you treat automations as code?" before anyone asks.
