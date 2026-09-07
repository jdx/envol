use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use reqwest::blocking::Client;
use serde_json::{Value, json};
use std::path::PathBuf;

#[derive(Parser)]
#[command(version, about = "Prepare, inspect, and promote CLI releases")]
struct Args {
    #[arg(long, env = "ENVOL_URL", default_value = "http://localhost:8787")]
    server: String,
    #[arg(long, env = "ENVOL_ADMIN_TOKEN", hide_env_values = true)]
    token: Option<String>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Check the syntax and required fields of envol.toml locally.
    Check {
        #[arg(default_value = "envol.toml")]
        file: PathBuf,
    },
    /// List projects, release lines, and recent candidates.
    Status,
    /// Freeze a release line and prepare a candidate.
    Prepare {
        #[arg(long)]
        line: String,
        #[arg(long)]
        version: String,
        #[arg(long)]
        request_key: Option<String>,
    },
    /// Inspect a candidate and its event journal.
    Inspect { candidate: String },
    /// Promote validated artifacts; creates the release tag near the end.
    Promote { candidate: String },
    /// Cancel an unpublished candidate and release the branch freeze.
    Cancel { candidate: String },
    /// Resume the latest failed job.
    Retry { candidate: String },
    /// Process one queued job (normally performed by the server).
    Tick,
}

fn main() -> Result<()> {
    let args = Args::parse();
    if let Command::Check { file } = &args.command {
        let text = std::fs::read_to_string(file).context("Read configuration")?;
        let doc: toml::Value = toml::from_str(&text).context("Parse configuration")?;
        for field in ["workflow", "version_files", "required_artifacts", "lines"] {
            if doc.get(field).is_none() {
                bail!("Missing {field}");
            }
        }
        println!("{}: configuration syntax is valid", file.display());
        return Ok(());
    }
    let token = args
        .token
        .context("Set ENVOL_ADMIN_TOKEN or pass --token")?;
    let (path, body) = match args.command {
        Command::Status => ("/api/admin/overview".into(), None),
        Command::Prepare {
            line,
            version,
            request_key,
        } => {
            let key = request_key.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let response = Client::new()
                .post(format!(
                    "{}/api/admin/lines/{line}/candidates",
                    args.server.trim_end_matches('/')
                ))
                .bearer_auth(token)
                .header("Idempotency-Key", &key)
                .json(&json!({ "version": version }))
                .send()?;
            eprintln!("Request key: {key} (reuse this key if retrying an uncertain request)");
            return print_response(response);
        }
        Command::Inspect { candidate } => (format!("/api/admin/candidates/{candidate}"), None),
        Command::Promote { candidate } => (
            format!("/api/admin/candidates/{candidate}/promote"),
            Some(json!({})),
        ),
        Command::Cancel { candidate } => (
            format!("/api/admin/candidates/{candidate}/cancel"),
            Some(json!({})),
        ),
        Command::Retry { candidate } => (
            format!("/api/admin/candidates/{candidate}/retry"),
            Some(json!({})),
        ),
        Command::Tick => ("/api/admin/tick".into(), Some(json!({}))),
        Command::Check { .. } => unreachable!(),
    };
    let url = format!("{}{path}", args.server.trim_end_matches('/'));
    let client = Client::new();
    let request = match body {
        Some(body) => client.post(url).json(&body),
        None => client.get(url),
    };
    print_response(request.bearer_auth(token).send()?)
}

fn print_response(response: reqwest::blocking::Response) -> Result<()> {
    let status = response.status();
    let body: Value = response.json().context("Read Envol response")?;
    if !status.is_success() {
        bail!("Envol {status}: {}", body.get("error").unwrap_or(&body));
    }
    println!("{}", serde_json::to_string_pretty(&body)?);
    Ok(())
}
