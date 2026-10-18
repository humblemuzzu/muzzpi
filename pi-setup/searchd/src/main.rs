use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use searchd::content::Budget;
use searchd::engine::{Engine, Options};
use searchd::selftest::Start;
use searchd::{selftest, server};

const USAGE: &str = "usage: searchd serve [--root DIR] | selftest [--rg PATH] [--stamp] [--verbose] \
                     | query JSON | status | version | uninstall";

fn query(json: &str) -> ExitCode {
	let sock = server::socket_path(&server::data_dir());
	let mut s = match UnixStream::connect(&sock) {
		Ok(s) => s,
		Err(e) => {
			eprintln!("searchd: {}: {e}", sock.display());
			return ExitCode::from(1);
		}
	};
	if writeln!(s, "{json}").is_err() {
		return ExitCode::from(1);
	}
	let _ = s.shutdown(std::net::Shutdown::Write);
	for l in BufReader::new(s).lines().map_while(Result::ok) {
		println!("{l}");
	}
	ExitCode::SUCCESS
}

/// Removes the daemon: its data folder (after asking a running one to exit)
/// and the binary this command runs from.
fn uninstall() -> ExitCode {
	match server::ensure_data_dir() {
		Ok(dir) => {
			server::shut_down(&dir);
			if !server::wait_unlocked(&dir, Duration::from_secs(5)) {
				eprintln!("searchd: a daemon is still running on {}; remove the folder once it has exited", dir.display());
				return ExitCode::from(1);
			}
			if let Err(e) = std::fs::remove_dir_all(&dir) {
				eprintln!("searchd: {}: {e}", dir.display());
				return ExitCode::from(1);
			}
		}
		Err(e) => eprintln!("searchd: no data folder to remove: {e}"),
	}
	match std::env::current_exe().and_then(std::fs::remove_file) {
		Ok(()) => ExitCode::SUCCESS,
		Err(e) => {
			eprintln!("searchd: cannot remove its own binary: {e}");
			ExitCode::from(1)
		}
	}
}

/// Runs the parity check against the rg now installed and records the answer,
/// so the next start does not repeat it.
fn recheck(dir: &Path, rg: Option<&str>) -> bool {
	let report = searchd::engine::parallel_background(|| selftest::run("rg"));
	let pass = report.failures.is_empty() && report.compared > 0;
	if let Err(e) = server::write_stamp(dir, rg, pass) {
		eprintln!("searchd: cannot record the selftest: {e}");
	}
	if pass {
		eprintln!("searchd: the check passed: {} queries matched rg", report.compared);
		return true;
	}
	for f in report.failures.iter().take(3) {
		eprintln!("searchd: FAIL {f}");
	}
	eprintln!(
		"searchd: {} of {} queries differed from rg; nothing is indexed, find and grep run rg",
		report.failures.len(),
		report.compared
	);
	false
}

fn main() -> ExitCode {
	let args: Vec<String> = std::env::args().skip(1).collect();
	let flag = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
	match args.first().map(String::as_str) {
		Some("serve") if std::env::var_os("MallocSpaceEfficient").is_none() => {
			// macOS's allocator keeps freed small blocks dirty by default; this
			// mode halves what a daemon holds after its walk (measured 431 -> 240 MB
			// RSS for a whole-disk index). It is read at launch, hence the re-exec.
			use std::os::unix::process::CommandExt;
			let exe = match std::env::current_exe() {
				Ok(exe) => exe,
				Err(e) => {
					eprintln!("searchd: cannot find its own path to restart itself: {e}");
					return ExitCode::from(1);
				}
			};
			let err = std::process::Command::new(exe).args(&args).env("MallocSpaceEfficient", "1").exec();
			eprintln!("searchd: {err}");
			ExitCode::from(1)
		}
		Some("serve") => {
			// Crash-only: any bug ends the process, and the next search starts a
			// fresh one, rather than leaving a daemon whose locks are poisoned.
			std::panic::set_hook(Box::new(|info| {
				eprintln!("searchd: {info}");
				unsafe { libc::_exit(70) };
			}));
			let home = match server::checked_home(std::env::var_os("HOME").as_deref()) {
				Ok(h) => h,
				Err(e) => {
					eprintln!("searchd: {e}");
					return ExitCode::from(1);
				}
			};
			let data = match server::ensure_data_dir() {
				Ok(d) => d,
				Err(e) => {
					eprintln!("searchd: {}: {e}", server::data_dir().display());
					return ExitCode::from(1);
				}
			};
			if let Err(e) = server::log_stderr(&data) {
				eprintln!("searchd: {}: {e}", data.join("searchd.log").display());
				return ExitCode::from(1);
			}
			let root = flag("--root").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"));
			let root = std::fs::canonicalize(&root).unwrap_or(root);
			let rg = selftest::rg_version("rg");
			eprintln!(
				"searchd {} start: rg {:?}, root {}, home {}",
				env!("CARGO_PKG_VERSION"),
				rg,
				root.display(),
				home.display()
			);
			if let Err(e) = server::refuse_dataless_reads() {
				eprintln!("searchd: a dataless file may be downloaded by a read: {e}");
			}
			let lock = match server::take_lock() {
				Ok(Some(lock)) => lock,
				Ok(None) => {
					let dir = server::data_dir();
					if server::answers_status(&dir) {
						eprintln!("searchd: already running");
						return ExitCode::SUCCESS;
					}
					eprintln!("searchd: {} holds the lock but no daemon answers there", dir.display());
					return ExitCode::from(server::LOCKED_UNANSWERED);
				}
				Err(e) => {
					eprintln!("searchd: {}: {e}", server::data_dir().display());
					return ExitCode::from(1);
				}
			};
			let stamp = server::read_stamp(&data);
			match selftest::start_decision(stamp.as_ref(), rg.as_deref(), env!("CARGO_PKG_VERSION")) {
				Start::Serve => eprintln!("searchd: this build was checked against this rg; serving"),
				Start::Recheck => {
					eprintln!("searchd: rg is not the one the selftest was made with; checking this build against {rg:?}");
					if !recheck(&data, rg.as_deref()) {
						return ExitCode::from(1);
					}
				}
				Start::Exit(reason) => {
					eprintln!("searchd: {reason}");
					return ExitCode::from(1);
				}
			}
			// The sync cookie must lie inside the watched root to come back.
			let cookie_dir = if data.starts_with(&root) {
				data.join("live")
			} else {
				root.join(".searchd-live")
			};
			let engine = Engine::new(Options {
				root,
				home: home.clone(),
				threads: 6,
				own_dir: Some(data.clone()),
				exact_max_dirs: searchd::engine::EXACT_MAX_DIRS,
				scan_first: searchd::engine::SCAN_FIRST,
				cookie_dir,
				content_dir: Some(data.join("content")),
				index_under: home,
				budget: Budget {
					free_floor: 5 << 30,
					free_percent: 5,
					cap: 1 << 30,
				},
				quiet_window: Duration::from_secs(120),
				rebuild_interval: Duration::from_secs(600),
			});
			match server::serve(engine, lock) {
				Ok(()) => ExitCode::SUCCESS,
				Err(e) => {
					eprintln!("searchd: {e}");
					ExitCode::from(1)
				}
			}
		}
		Some("selftest") => {
			let rg = flag("--rg").unwrap_or_else(|| "rg".into());
			let report = selftest::run(&rg);
			for f in &report.failures {
				eprintln!("FAIL {f}");
			}
			if args.iter().any(|a| a == "--verbose") {
				for f in &report.fallbacks {
					eprintln!("to rg: {f}");
				}
			}
			println!(
				"searchd selftest: {} queries matched rg ({} with results), {} handed to rg, {} differed",
				report.compared - report.failures.len(),
				report.nonempty,
				report.fallbacks.len(),
				report.failures.len()
			);
			if !report.failures.is_empty() || report.compared == 0 {
				return ExitCode::from(1);
			}
			if args.iter().any(|a| a == "--stamp") {
				let dir = match server::ensure_data_dir() {
					Ok(d) => d,
					Err(e) => {
						eprintln!("searchd: cannot record the selftest: {e}");
						return ExitCode::from(1);
					}
				};
				if let Err(e) = server::write_stamp(&dir, selftest::rg_version(&rg).as_deref(), true) {
					eprintln!("searchd: cannot record the selftest: {e}");
					return ExitCode::from(1);
				}
			}
			ExitCode::SUCCESS
		}
		Some("query") => match args.get(1) {
			Some(j) => query(j),
			None => {
				eprintln!("{USAGE}");
				ExitCode::from(2)
			}
		},
		Some("status") => query(r#"{"op":"status"}"#),
		Some("version") => {
			println!("{}", env!("CARGO_PKG_VERSION"));
			ExitCode::SUCCESS
		}
		Some("uninstall") => uninstall(),
		_ => {
			eprintln!("{USAGE}");
			ExitCode::from(2)
		}
	}
}
