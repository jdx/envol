use anyhow::{Context, Result, bail};
use reqwest::blocking::Client;
use serde_json::{Value, json};
use std::path::PathBuf;
use usage::{Args as UsageArgs, Cli, Subcommands};

/// Prepare, inspect, and promote CLI releases.
#[derive(Cli)]
#[usage(bin = "envol", version)]
struct Args {
    /// Envol server URL.
    #[usage(long, global, env = "ENVOL_URL", default = "http://localhost:8787")]
    server: String,
    /// Envol administrator token.
    #[usage(long, global, env = "ENVOL_ADMIN_TOKEN", hide_env_values)]
    token: Option<String>,
    #[usage(subcommand)]
    command: Command,
}

#[derive(Subcommands)]
enum Command {
    /// Check the syntax and required fields of envol.toml locally.
    Check(Check),
    /// List projects, release lines, and recent candidates.
    Status,
    /// Freeze a release line and prepare a candidate.
    Prepare(Prepare),
    /// Inspect a candidate and its event journal.
    Inspect(Candidate),
    /// Promote validated artifacts; creates the release tag near the end.
    Promote(Candidate),
    /// Cancel an unpublished candidate and release the branch freeze.
    Cancel(Candidate),
    /// Resume the latest failed job.
    Retry(Candidate),
    /// Process one queued job (normally performed by the server).
    Tick,
}

#[derive(UsageArgs)]
struct Check {
    /// Configuration file to validate.
    #[usage(default = "envol.toml", value_hint = usage::ValueHint::FilePath)]
    file: PathBuf,
}

#[derive(UsageArgs)]
struct Prepare {
    /// Release line to prepare.
    #[usage(long)]
    line: String,
    /// Concrete release version.
    #[usage(long)]
    version: String,
    /// Idempotency key for safely retrying an uncertain request.
    #[usage(long)]
    request_key: Option<String>,
}

#[derive(UsageArgs)]
struct Candidate {
    /// Candidate ID.
    candidate: String,
}

fn main() -> Result<()> {
    let args = Args::parse();
    if let Command::Check(Check { file }) = &args.command {
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
        Command::Prepare(Prepare {
            line,
            version,
            request_key,
        }) => {
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
        Command::Inspect(Candidate { candidate }) => {
            (format!("/api/admin/candidates/{candidate}"), None)
        }
        Command::Promote(Candidate { candidate }) => (
            format!("/api/admin/candidates/{candidate}/promote"),
            Some(json!({})),
        ),
        Command::Cancel(Candidate { candidate }) => (
            format!("/api/admin/candidates/{candidate}/cancel"),
            Some(json!({})),
        ),
        Command::Retry(Candidate { candidate }) => (
            format!("/api/admin/candidates/{candidate}/retry"),
            Some(json!({})),
        ),
        Command::Tick => ("/api/admin/tick".into(), Some(json!({}))),
        Command::Check(_) => unreachable!(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn parses_prepare_with_global_options() {
        let argv = [
            OsStr::new("prepare"),
            OsStr::new("--line"),
            OsStr::new("next"),
            OsStr::new("--version"),
            OsStr::new("2.0.0-rc.1"),
            OsStr::new("--request-key"),
            OsStr::new("release-2"),
            OsStr::new("--server"),
            OsStr::new("https://envol.test"),
        ];
        let args = Args::parse_from(&argv).expect("valid command line");
        assert_eq!(args.server, "https://envol.test");
        let Command::Prepare(prepare) = args.command else {
            panic!("expected prepare command");
        };
        assert_eq!(prepare.line, "next");
        assert_eq!(prepare.version, "2.0.0-rc.1");
        assert_eq!(prepare.request_key.as_deref(), Some("release-2"));
    }

    #[test]
    fn check_defaults_to_envol_toml() {
        let args = Args::parse_from(&[OsStr::new("check")]).expect("valid command line");
        let Command::Check(check) = args.command else {
            panic!("expected check command");
        };
        assert_eq!(check.file, PathBuf::from("envol.toml"));
    }
}
