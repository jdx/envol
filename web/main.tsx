import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
type Candidate = {
  id: string;
  line_id: string;
  version: string;
  state: string;
  sha: string | null;
  error: string | null;
  frozen: number;
  created_at: string;
};
type Project = { id: string; repo: string };
type Line = {
  id: string;
  project_id: string;
  name: string;
  channel: string;
  branch: string;
};
type Overview = {
  projects: Project[];
  lines: Line[];
  candidates: Candidate[];
  configured: boolean;
  metrics: { project_id: string; metric: string; day: string; value: number }[];
};
const initial: Overview = {
  projects: [],
  lines: [],
  candidates: [],
  configured: false,
  metrics: [],
};
function App() {
  const [token, setToken] = useState(
      sessionStorage.getItem("envol-token") ?? "",
    ),
    [data, setData] = useState(initial),
    [tab, setTab] = useState("Releases"),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [selected, setSelected] = useState<string | null>(null),
    [detail, setDetail] = useState<any>(null),
    [modal, setModal] = useState<"release" | "project" | "connect" | null>(
      null,
    ),
    [busy, setBusy] = useState(false);
  async function request(
    path: string,
    body?: unknown,
    key?: string,
  ): Promise<any> {
    const res = await fetch(path, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as any;
    if (!res.ok) throw new Error(json.error ?? res.statusText);
    return json;
  }
  async function refresh() {
    setLoading(true);
    try {
      if (token) setData(await request("/api/admin/overview"));
      else {
        const projects = await request("/api/public/projects");
        setData({ ...initial, projects });
      }
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 15000);
    return () => clearInterval(timer);
  }, [token]);
  useEffect(() => {
    if (!selected) return;
    request(`/api/admin/candidates/${selected}`)
      .then(setDetail)
      .catch((e) => setError(String(e)));
  }, [selected, data]);
  async function action(id: string, action: string) {
    setBusy(true);
    try {
      await request(`/api/admin/candidates/${id}/${action}`, {});
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const active = data.candidates.filter(
      (c) => !["released", "cancelled", "failed"].includes(c.state),
    ),
    released = data.candidates.filter((c) => c.state === "released"),
    frozen = data.candidates.filter((c) => c.frozen);
  function projectFor(c: Candidate) {
    const line = data.lines.find((l) => l.id === c.line_id);
    return (
      data.projects.find((p) => p.id === line?.project_id)?.repo ??
      "Unknown project"
    );
  }
  return (
    <div className="layout">
      <aside>
        <a className="brand" href="/">
          <span className="mark">↗</span> envol
          <span className="beta">EARLY ACCESS</span>
        </a>
        <div className="workspace">
          <span className="avatar">e</span>
          <div>
            Flight control
            <small>{token ? "Your workspace" : "Public workspace"}</small>
          </div>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {["Releases", "Projects", "Audience"].map((name, i) => (
            <button
              className={tab === name ? "active" : ""}
              onClick={() => {
                setTab(name);
                setSelected(null);
              }}
              key={name}
            >
              <span>{["↗", "▦", "◷"][i]}</span>
              {name}
              {name === "Releases" && active.length > 0 && (
                <b>{active.length}</b>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="status-dot" />{" "}
          {data.configured ? "GitHub App connected" : "Local workspace"}
          <button onClick={() => setModal("connect")}>
            {token ? "Change connection" : "Connect workspace"} ↗
          </button>
          <a href="https://github.com/jdx/envol">Open source on GitHub ↗</a>
        </div>
      </aside>
      <main>
        <header>
          <span>
            Workspace <span className="muted">/</span> {tab}
          </span>
          <div>
            <span className="live-dot" />
            {loading ? "Syncing…" : "Live view"}
            <button className="icon" aria-label="Refresh" onClick={refresh}>
              ↻
            </button>
          </div>
        </header>
        <section className="content">
          <div className="eyebrow">A LITTLE LESS RELEASE ANXIETY.</div>
          <div className="heading">
            <div>
              <h1>
                {tab === "Releases"
                  ? "Ready for takeoff."
                  : tab === "Projects"
                    ? "Your fleet."
                    : "Watch it grow."}
              </h1>
              <p>
                {tab === "Releases"
                  ? "Build once. Check everything. Ship with confidence."
                  : tab === "Projects"
                    ? "One place for every CLI, release line, and destination."
                    : "The people and projects discovering your work."}
              </p>
            </div>
            <button
              className="primary"
              onClick={() =>
                setModal(
                  token
                    ? tab === "Projects"
                      ? "project"
                      : "release"
                    : "connect",
                )
              }
            >
              ＋ {tab === "Projects" ? "Add project" : "Prepare release"}
            </button>
          </div>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <div className="stats">
            {[
              [data.projects.length, "PROJECTS", "Across your workspace"],
              [active.length, "IN FLIGHT", "Candidates being prepared"],
              [released.length, "RELEASED", "Validated and published"],
              [frozen.length, "BRANCHES FROZEN", "Protected release windows"],
            ].map(([value, label, caption]) => (
              <article key={label}>
                <span>{label}</span>
                <strong>
                  {value}
                  <i>↗</i>
                </strong>
                <small>{caption}</small>
              </article>
            ))}
          </div>
          {tab === "Releases" && (
            <>
              <div className="section-title">
                <h2>
                  Release activity <span>{data.candidates.length}</span>
                </h2>
                <span className="muted">
                  Exact commits. Immutable artifacts.
                </span>
              </div>
              {!data.candidates.length ? (
                <div className="empty">
                  <div className="orbit">↗</div>
                  <h2>Your next release starts here.</h2>
                  <p>
                    Connect a repository to prepare a frozen candidate.
                    <br />
                    Nothing reaches main until the checks are complete.
                  </p>
                  <button
                    className="secondary"
                    onClick={() => setModal(token ? "project" : "connect")}
                  >
                    {token ? "Connect your first project" : "Connect workspace"}{" "}
                    ↗
                  </button>
                </div>
              ) : (
                <div className="releases">
                  {data.candidates.map((c) => (
                    <button
                      className={`release-row ${selected === c.id ? "selected" : ""}`}
                      key={c.id}
                      onClick={() => setSelected(c.id)}
                    >
                      <div className="project-icon">
                        {projectFor(c).split("/")[1]?.[0] ?? "e"}
                      </div>
                      <div>
                        <strong>
                          {projectFor(c)}{" "}
                          <span className="version">{c.version}</span>
                        </strong>
                        <small>
                          {c.sha?.slice(0, 7) ?? "Awaiting source snapshot"} ·{" "}
                          {new Date(c.created_at).toLocaleDateString()}
                        </small>
                      </div>
                      <span className={`badge ${c.state}`}>
                        {c.frozen ? "▣ " : ""}
                        {c.state}
                      </span>
                      <span className="arrow">↗</span>
                    </button>
                  ))}
                </div>
              )}
              {selected && detail && (
                <div className="detail">
                  <div className="section-title">
                    <h2>Candidate {detail.candidate.version}</h2>
                    <button className="icon" onClick={() => setSelected(null)}>
                      ×
                    </button>
                  </div>
                  <div className="pipeline">
                    {[
                      "queued",
                      "preparing",
                      "building",
                      "ready",
                      "promoting",
                      "publishing",
                      "released",
                    ].map((s) => (
                      <span
                        className={
                          s === detail.candidate.state ? "current" : ""
                        }
                        key={s}
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                  <code>{detail.candidate.sha ?? "Source commit pending"}</code>
                  {detail.candidate.error && (
                    <p className="error">{detail.candidate.error}</p>
                  )}
                  <div className="actions">
                    {detail.candidate.state === "ready" && (
                      <button
                        disabled={busy}
                        className="primary"
                        onClick={() => action(selected, "promote")}
                      >
                        Promote release ↗
                      </button>
                    )}
                    {![
                      "promoting",
                      "publishing",
                      "released",
                      "cancelled",
                    ].includes(detail.candidate.state) && (
                      <button
                        disabled={busy}
                        className="secondary"
                        onClick={() => action(selected, "cancel")}
                      >
                        Cancel candidate
                      </button>
                    )}
                    {detail.jobs?.some((j: any) => j.state === "failed") && (
                      <button
                        disabled={busy}
                        className="secondary"
                        onClick={() => action(selected, "retry")}
                      >
                        Retry failed step
                      </button>
                    )}
                  </div>
                  <h3>Retained artifacts</h3>
                  {detail.artifacts.length ? (
                    detail.artifacts.map((a: any) => (
                      <p key={a.name}>
                        {a.name}{" "}
                        <small>
                          {(a.size / 1024).toFixed(1)} KB ·{" "}
                          {a.digest.slice(0, 12)}
                        </small>
                      </p>
                    ))
                  ) : (
                    <p className="muted">
                      Artifacts appear here after the build uploads them.
                    </p>
                  )}
                  <h3>Event journal</h3>
                  {detail.events.map((e: any) => (
                    <p key={e.id}>
                      <small>
                        {new Date(e.created_at).toLocaleTimeString()}
                      </small>{" "}
                      {e.detail}
                    </p>
                  ))}
                </div>
              )}
              <div className="principles">
                <article>
                  <span>01 / PREPARE</span>
                  <h3>A snapshot, not a moving target.</h3>
                  <p>
                    Freeze the source branch and give every candidate an exact
                    commit.
                  </p>
                </article>
                <article>
                  <span>02 / VALIDATE</span>
                  <h3>Find the failures first.</h3>
                  <p>
                    Build, test, package, and sign before making a release
                    public.
                  </p>
                </article>
                <article>
                  <span>03 / PROMOTE</span>
                  <h3>The same bytes, everywhere.</h3>
                  <p>
                    Tag late. Publish retained artifacts. Resume where you left
                    off.
                  </p>
                </article>
              </div>
            </>
          )}
          {tab === "Projects" && (
            <div className="project-grid">
              {data.projects.map((p) => (
                <article className="project-card" key={p.id}>
                  <div className="project-icon">
                    {p.repo.split("/")[1]?.[0]}
                  </div>
                  <h2>{p.repo}</h2>
                  {data.lines
                    .filter((l) => l.project_id === p.id)
                    .map((l) => (
                      <p key={l.id}>
                        <span className="badge">{l.channel}</span> {l.name}{" "}
                        <code>{l.branch}</code>
                      </p>
                    ))}
                  <a href={`https://github.com/${p.repo}`}>View repository ↗</a>
                </article>
              ))}
              {!data.projects.length && (
                <div className="empty">
                  <h2>No projects connected yet.</h2>
                  <p>Add a GitHub App installation to get started.</p>
                </div>
              )}
            </div>
          )}
          {tab === "Audience" && (
            <div className="detail">
              <h2>Adoption, with context.</h2>
              <p className="muted">
                Daily GitHub snapshots. Downloads include supporting release
                assets and are not unique users.
              </p>
              {data.projects.map((p) => {
                const stats = data.metrics.filter((m) => m.project_id === p.id);
                return (
                  <article className="audience-project" key={p.id}>
                    <h3>{p.repo}</h3>
                    {["stars", "downloads"].map((metric) => {
                      const points = stats
                        .filter((m) => m.metric === metric)
                        .sort((a, b) => a.day.localeCompare(b.day));
                      const latest = points.at(-1);
                      return (
                        <div key={metric}>
                          <span>{metric}</span>
                          <strong>
                            {latest
                              ? new Intl.NumberFormat().format(latest.value)
                              : "—"}
                          </strong>
                          <small>
                            {latest
                              ? `As of ${latest.day}`
                              : "No observations yet"}
                          </small>
                          {points.length > 1 && (
                            <Sparkline values={points.map((p) => p.value)} />
                          )}
                        </div>
                      );
                    })}
                  </article>
                );
              })}
              {token && (
                <button
                  className="secondary"
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await request("/api/admin/metrics/refresh", {});
                      await refresh();
                    } catch (e) {
                      setError(String(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                  disabled={busy}
                >
                  Refresh metrics ↻
                </button>
              )}
            </div>
          )}
          <footer>
            <span>
              envol <span className="muted">/</span> software, cleared for
              departure.
            </span>
            <span>Built in the open ↗</span>
          </footer>
        </section>
      </main>
      {modal && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dialog-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="close"
              onClick={() => setModal(null)}
              aria-label="Close"
            >
              ×
            </button>
            <h2 id="dialog-title">
              {modal === "connect"
                ? "Connect workspace"
                : modal === "project"
                  ? "Add a project"
                  : "Prepare a release"}
            </h2>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const values = new FormData(e.currentTarget);
                setBusy(true);
                try {
                  if (modal === "connect") {
                    const value = String(values.get("token"));
                    sessionStorage.setItem("envol-token", value);
                    setToken(value);
                  } else if (modal === "project")
                    await request("/api/admin/projects", {
                      repo: values.get("repo"),
                      installation_id: Number(values.get("installation")),
                      public: values.get("public") === "on",
                      config: values.get("config"),
                    });
                  else
                    await request(
                      `/api/admin/lines/${values.get("line")}/candidates`,
                      { version: values.get("version") },
                      crypto.randomUUID(),
                    );
                  setModal(null);
                  await refresh();
                } catch (e) {
                  setError(String(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {modal === "connect" ? (
                <>
                  <p>
                    Enter your server’s administrator token. It stays in this
                    browser tab’s session.
                  </p>
                  <label>
                    Administrator token
                    <input
                      name="token"
                      type="password"
                      required
                      autoComplete="off"
                    />
                  </label>
                </>
              ) : modal === "project" ? (
                <>
                  <label>
                    GitHub repository
                    <input name="repo" placeholder="owner/project" required />
                  </label>
                  <label>
                    App installation ID
                    <input name="installation" type="number" min="1" required />
                  </label>
                  <label>
                    envol.toml
                    <textarea
                      name="config"
                      rows={9}
                      defaultValue={
                        'workflow = "envol.yml"\nversion_files = ["Cargo.toml"]\nrequired_artifacts = ["envol-linux-x64.tar.gz"]\n\n[lines.stable]\nbranch = "main"\nchannel = "stable"'
                      }
                      required
                    />
                  </label>
                  <label className="checkbox">
                    <input name="public" type="checkbox" /> Public adoption page
                  </label>
                </>
              ) : (
                <>
                  <p>
                    The source branch will be frozen while this candidate
                    builds.
                  </p>
                  <label>
                    Release line
                    <select name="line" required>
                      {data.lines.map((l) => (
                        <option key={l.id} value={l.id}>
                          {
                            data.projects.find((p) => p.id === l.project_id)
                              ?.repo
                          }{" "}
                          / {l.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Final version
                    <input name="version" placeholder="0.1.0" required />
                  </label>
                </>
              )}
              <button
                className="primary"
                disabled={busy || (modal === "release" && !data.lines.length)}
              >
                {busy
                  ? "Working…"
                  : modal === "connect"
                    ? "Connect"
                    : modal === "project"
                      ? "Add project"
                      : "Prepare candidate"}{" "}
                ↗
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
function Sparkline({ values }: { values: number[] }) {
  const min = Math.min(...values),
    max = Math.max(...values);
  return (
    <svg viewBox="0 0 240 50" role="img" aria-label="Metric history">
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        points={values
          .map(
            (v, i) =>
              `${(i / (values.length - 1)) * 240},${45 - ((v - min) / (max - min || 1)) * 40}`,
          )
          .join(" ")}
      />
    </svg>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
