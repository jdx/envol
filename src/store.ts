import type { Database } from "./db.ts";
import { one } from "./db.ts";
import type { Candidate, Line, State } from "./model.ts";
import { releaseVersion } from "./model.ts";
import { RequestError } from "./errors.ts";
export const now = () => new Date().toISOString();
export class CandidateNotFoundError extends Error {}
const edges: Partial<Record<State, State[]>> = {
  queued: ["preparing", "cancelling"],
  preparing: ["building", "blocked", "cancelling"],
  building: ["ready", "blocked", "cancelling"],
  ready: ["promoting", "cancelling"],
  promoting: ["publishing", "blocked"],
  publishing: ["released", "blocked"],
  blocked: ["preparing", "promoting", "publishing", "cancelling"],
  cancelling: ["cancelled", "blocked"],
};
export class Store {
  constructor(readonly db: Database) {}
  async candidate(id: string) {
    const c = await one<Candidate>(
      this.db,
      "SELECT * FROM candidates WHERE id=?",
      [id],
    );
    if (!c) throw new CandidateNotFoundError("Candidate not found");
    return c;
  }
  async event(id: string, kind: string, detail: string) {
    await this.db.run(
      "INSERT INTO events(candidate_id,kind,detail,created_at) VALUES(?,?,?,?)",
      [id, kind, detail, now()],
    );
  }
  async create(line: Line, version: string, key: string) {
    if (!key || key.length > 200)
      throw new RequestError(
        "Idempotency-Key required (maximum 200 characters)",
      );
    releaseVersion(version, line.channel);
    const existing = await one<Candidate>(
      this.db,
      "SELECT * FROM candidates WHERE line_id=? AND request_key=?",
      [line.id, key],
    );
    if (existing) {
      if (existing.version !== version)
        throw new RequestError(
          "Idempotency key already used for another version",
          409,
        );
      return existing;
    }
    const id = crypto.randomUUID(),
      time = now();
    await this.db.batch([
      {
        sql: "INSERT INTO candidates(id,line_id,request_key,version,tag,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
        params: [
          id,
          line.id,
          key,
          version,
          `v${version}`,
          "queued",
          time,
          time,
        ],
      },
      {
        sql: "UPDATE lines SET candidate_id=? WHERE id=?",
        params: [id, line.id],
      },
      {
        sql: "INSERT INTO jobs(id,candidate_id,kind) VALUES(?,?,?)",
        params: [crypto.randomUUID(), id, "prepare"],
      },
    ]);
    return this.candidate(id);
  }
  async transition(c: Candidate, to: State) {
    if (!edges[c.state]?.includes(to))
      throw new Error(`Invalid transition ${c.state} → ${to}`);
    const changed = await this.db.run(
      "UPDATE candidates SET state=?,revision=revision+1,updated_at=? WHERE id=? AND state=? AND revision=?",
      [to, now(), c.id, c.state, c.revision],
    );
    if (!changed) throw new Error("Candidate changed concurrently");
    await this.event(c.id, to, `${c.state} → ${to}`);
    return this.candidate(c.id);
  }
  async enqueue(id: string, kind: string) {
    await this.db.run(
      "INSERT INTO jobs(id,candidate_id,kind) SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM jobs WHERE candidate_id=? AND kind=? AND state IN ('pending','running'))",
      [crypto.randomUUID(), id, kind, id, kind],
    );
  }
  async claim() {
    const time = Date.now();
    const job = await one<{
      id: string;
      candidate_id: string;
      kind: string;
      fence: number;
    }>(
      this.db,
      "UPDATE jobs SET state='running',lease_until=?,fence=fence+1,attempts=attempts+1 WHERE id=(SELECT j.id FROM jobs j WHERE ((j.state='pending' AND j.lease_until<=?) OR (j.state='running' AND j.lease_until<?)) AND NOT EXISTS(SELECT 1 FROM jobs busy WHERE busy.candidate_id=j.candidate_id AND busy.id<>j.id AND busy.state='running' AND busy.lease_until>=?) ORDER BY j.rowid LIMIT 1) RETURNING *",
      [time + 240000, time, time, time],
    );
    return job;
  }
  async finish(id: string, fence: number, error?: string) {
    return Boolean(
      await this.db.run(
        "UPDATE jobs SET state=?,error=? WHERE id=? AND fence=?",
        [error ? "failed" : "done", error ?? null, id, fence],
      ),
    );
  }
  async defer(id: string, fence: number, delay = 15000) {
    return Boolean(
      await this.db.run(
        "UPDATE jobs SET state='pending',lease_until=?,error=NULL WHERE id=? AND fence=? AND state='running'",
        [Date.now() + delay, id, fence],
      ),
    );
  }
  async succeed(id: string, candidateId: string, fence: number) {
    await this.db.batch([
      {
        sql: "UPDATE candidates SET error=NULL,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND fence=? AND state='running')",
        params: [now(), candidateId, id, fence],
      },
      {
        sql: "UPDATE jobs SET state='done',error=NULL WHERE id=? AND fence=? AND state='running'",
        params: [id, fence],
      },
    ]);
  }
}
