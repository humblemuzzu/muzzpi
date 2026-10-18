//! What the daemon does with the machine before it answers anything: which rg
//! it serves for, the folders it will write to, its log, and how it is removed.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use searchd::selftest::{TempRoot, temp_root_under};
use searchd::server;

const BIN: &str = env!("CARGO_BIN_EXE_searchd");
const VERSION: &str = env!("CARGO_PKG_VERSION");

/// A socket address holds 104 bytes, and the temp folder macOS hands out is
/// long: the daemon's data folder is made under `/tmp`.
fn short(tag: &str) -> TempRoot {
	temp_root_under(Path::new("/tmp"), tag)
}

struct Daemon {
	child: Child,
	stderr: PathBuf,
}

impl Daemon {
	fn start(mut cmd: Command, stderr_to: &Path) -> Daemon {
		let log = std::fs::File::create(stderr_to).unwrap();
		cmd.stdout(Stdio::null()).stderr(Stdio::from(log));
		Daemon { child: cmd.spawn().expect("the daemon runs"), stderr: stderr_to.to_path_buf() }
	}

	/// Waits for the process to end, killing it after `limit`.
	fn finish(&mut self, limit: Duration) -> Option<std::process::ExitStatus> {
		let until = Instant::now() + limit;
		loop {
			if let Ok(Some(status)) = self.child.try_wait() {
				return Some(status);
			}
			if Instant::now() >= until {
				let _ = self.child.kill();
				let _ = self.child.wait();
				return None;
			}
			std::thread::sleep(Duration::from_millis(50));
		}
	}

	fn stderr(&self) -> String {
		std::fs::read_to_string(&self.stderr).unwrap_or_default()
	}

	fn wait_serving(&self, data: &Path) {
		let until = Instant::now() + Duration::from_secs(180);
		while Instant::now() < until {
			if server::answers_status(data) {
				return;
			}
			std::thread::sleep(Duration::from_millis(50));
		}
		let log = std::fs::read_to_string(data.join("searchd.log")).unwrap_or_default();
		panic!("the daemon never answered. stderr: {}\nlog: {log}", self.stderr());
	}
}

impl Drop for Daemon {
	fn drop(&mut self) {
		let _ = self.child.kill();
		let _ = self.child.wait();
	}
}

fn serve_cmd(bin: &Path, data: &Path, tree: &Path) -> Command {
	let mut cmd = Command::new(bin);
	cmd.arg("serve").arg("--root").arg(tree).env("SEARCHD_DIR", data);
	cmd
}

fn rg_line() -> String {
	let out = Command::new("rg").arg("--version").output().unwrap();
	String::from_utf8_lossy(&out.stdout).lines().next().unwrap().to_string()
}

fn record(data: &Path, rg: &str, searchd: &str, ok: bool) {
	std::fs::create_dir_all(data).unwrap();
	let stamp = serde_json::json!({ "rg": rg, "searchd": searchd, "ok": ok });
	std::fs::write(data.join("selftest.json"), stamp.to_string()).unwrap();
}

fn tree_at(root: &Path) -> PathBuf {
	let tree = root.join("tree");
	std::fs::create_dir_all(&tree).unwrap();
	std::fs::write(tree.join("f.txt"), b"needle\n").unwrap();
	tree
}

/// An `rg` on PATH that counts what runs it, then hands over to the real one.
fn counting_rg(root: &Path) -> (PathBuf, PathBuf) {
	let real = Command::new("sh").arg("-c").arg("command -v rg").output().unwrap();
	let real = String::from_utf8_lossy(&real.stdout).trim().to_string();
	let dir = root.join("shim");
	std::fs::create_dir_all(&dir).unwrap();
	let counter = root.join("rg-calls");
	let script = format!("#!/bin/sh\necho x >> \"$RG_COUNTER\"\nexec {real} \"$@\"\n");
	std::fs::write(dir.join("rg"), script).unwrap();
	std::fs::set_permissions(dir.join("rg"), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
	(dir, counter)
}

fn calls(counter: &Path) -> usize {
	std::fs::read_to_string(counter).map_or(0, |t| t.lines().count())
}

/// A daemon with no stamp must build nothing: it used to walk the whole disk
/// and index it for four hours while refusing every query.
#[test]
fn a_daemon_without_a_stamp_indexes_nothing_and_says_why() {
	let root = short("no-stamp");
	let data = root.join("data");
	let tree = tree_at(&root);
	let mut daemon = Daemon::start(serve_cmd(Path::new(BIN), &data, &tree), &root.join("stderr"));
	let status = daemon.finish(Duration::from_secs(60)).expect("no stamp must end the daemon, not start one");
	assert!(!status.success(), "{status}");
	assert!(!data.join("content").exists(), "a content index was built with no passing selftest");
	let log = std::fs::read_to_string(data.join("searchd.log")).unwrap();
	assert!(log.contains("start:"), "the log has no start line: {log}");
	for expect in [VERSION, tree.to_str().unwrap(), "no passing selftest recorded"] {
		assert!(log.contains(expect), "{expect:?} is not in the log: {log}");
	}
}

#[test]
fn a_stamp_from_another_build_stops_the_daemon() {
	let root = short("other-build");
	let data = root.join("data");
	record(&data, &rg_line(), "0.0.1", true);
	let tree = tree_at(&root);
	let mut daemon = Daemon::start(serve_cmd(Path::new(BIN), &data, &tree), &root.join("stderr"));
	let status = daemon.finish(Duration::from_secs(60)).expect("another build's stamp must end the daemon");
	assert!(!status.success(), "{status}");
	assert!(!data.join("content").exists());
	let log = std::fs::read_to_string(data.join("searchd.log")).unwrap();
	assert!(log.contains("another searchd build"), "{log}");
}

/// A stamp that failed for this very rg is final: the client respawns the
/// daemon every 60 s, and a check each time would run the whole selftest
/// forever.
#[test]
fn a_stamp_that_failed_for_this_rg_is_not_checked_again() {
	let root = short("failed-stamp");
	let data = root.join("data");
	record(&data, &rg_line(), VERSION, false);
	let tree = tree_at(&root);
	let (shim, counter) = counting_rg(&root);
	let mut cmd = serve_cmd(Path::new(BIN), &data, &tree);
	cmd.env("PATH", format!("{}:{}", shim.display(), std::env::var("PATH").unwrap())).env("RG_COUNTER", &counter);
	let mut daemon = Daemon::start(cmd, &root.join("stderr"));
	let status = daemon.finish(Duration::from_secs(60)).expect("a failed stamp must end the daemon");
	assert!(!status.success(), "{status}");
	assert!(!data.join("content").exists());
	let ran = calls(&counter);
	assert!(ran <= 2, "the daemon ran rg {ran} times: it checked itself again instead of exiting");
	let log = std::fs::read_to_string(data.join("searchd.log")).unwrap();
	assert!(log.contains("the selftest failed against this rg"), "{log}");
}

/// An upgraded rg heals itself: the daemon checks this build against the new
/// one, records the answer and serves — instead of refusing every query.
#[test]
fn an_upgraded_rg_makes_the_daemon_check_itself_and_serve() {
	let root = short("rg-upgrade");
	let data = root.join("data");
	record(&data, "ripgrep 0.0.0", VERSION, true);
	let tree = tree_at(&root);
	let (shim, counter) = counting_rg(&root);
	let mut cmd = serve_cmd(Path::new(BIN), &data, &tree);
	cmd.env("PATH", format!("{}:{}", shim.display(), std::env::var("PATH").unwrap())).env("RG_COUNTER", &counter);
	let daemon = Daemon::start(cmd, &root.join("stderr"));
	daemon.wait_serving(&data);
	let ran = calls(&counter);
	assert!(ran > 20, "the daemon ran rg {ran} times: no parity check happened");
	let stamp = server::read_stamp(&data).expect("the daemon must record the check it ran");
	assert_eq!(stamp["rg"], rg_line().as_str(), "{stamp}");
	assert_eq!(stamp["ok"], true, "{stamp}");
	let log = std::fs::read_to_string(data.join("searchd.log")).unwrap();
	assert!(log.contains("the check passed"), "{log}");
	server::shut_down(&data);
	let mut daemon = daemon;
	assert!(daemon.finish(Duration::from_secs(30)).is_some(), "the daemon did not shut down");
}

#[test]
fn the_daemon_refuses_to_run_without_a_home() {
	let root = short("no-home");
	let data = root.join("data");
	let tree = tree_at(&root);
	let mut cmd = serve_cmd(Path::new(BIN), &data, &tree);
	cmd.env_remove("HOME");
	let mut daemon = Daemon::start(cmd, &root.join("stderr"));
	let status = daemon.finish(Duration::from_secs(60)).expect("no HOME must end the daemon");
	assert!(!status.success(), "{status}");
	assert!(daemon.stderr().contains("HOME is not set"), "{}", daemon.stderr());
}

#[test]
fn the_daemon_refuses_a_data_folder_that_is_a_symlink() {
	let root = short("symlink-data");
	let real = root.join("real");
	std::fs::create_dir_all(&real).unwrap();
	let data = root.join("data");
	std::os::unix::fs::symlink(&real, &data).unwrap();
	let tree = tree_at(&root);
	let mut daemon = Daemon::start(serve_cmd(Path::new(BIN), &data, &tree), &root.join("stderr"));
	let status = daemon.finish(Duration::from_secs(60)).expect("a symlinked data folder must end the daemon");
	assert!(!status.success(), "{status}");
	assert!(daemon.stderr().contains("is not a directory"), "{}", daemon.stderr());
}

/// A second daemon exits 0 only when the first one is there to answer; a lock
/// nobody answers is a distinct failure, not a quiet success.
#[test]
fn a_second_daemon_exits_cleanly_only_when_the_first_answers() {
	let root = short("second-daemon");
	let data = root.join("data");
	record(&data, &rg_line(), VERSION, true);
	let tree = tree_at(&root);
	let first = Daemon::start(serve_cmd(Path::new(BIN), &data, &tree), &root.join("stderr"));
	first.wait_serving(&data);

	let mut second = Daemon::start(serve_cmd(Path::new(BIN), &data, &tree), &root.join("stderr2"));
	let status = second.finish(Duration::from_secs(60)).expect("the second daemon must exit");
	let log = std::fs::read_to_string(data.join("searchd.log")).unwrap_or_default();
	assert!(status.success(), "a daemon that answers must let the second exit 0: {status:?} {log}");

	let mut first = first;
	server::shut_down(&data);
	assert!(first.finish(Duration::from_secs(30)).is_some(), "the first daemon did not shut down");

	// A lock nobody answers for is a distinct failure, not a quiet success.
	let _ = std::fs::remove_file(data.join("searchd.sock"));
	let held = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(data.join("lock")).unwrap();
	assert_eq!(
		unsafe { libc::flock(std::os::fd::AsRawFd::as_raw_fd(&held), libc::LOCK_EX | libc::LOCK_NB) },
		0,
		"the test cannot hold the lock"
	);
	let mut third = Daemon::start(serve_cmd(Path::new(BIN), &data, &tree), &root.join("stderr3"));
	let status = third.finish(Duration::from_secs(60)).expect("the third daemon must exit");
	let log = std::fs::read_to_string(data.join("searchd.log")).unwrap_or_default();
	assert_eq!(status.code(), Some(server::LOCKED_UNANSWERED.into()), "{status:?} {log}");
	assert!(log.contains("no daemon answers"), "{log}");
}

/// `searchd uninstall` asks a running daemon to go, removes the data folder and
/// then the binary it was run from.
#[test]
fn uninstall_removes_the_data_folder_and_its_own_binary() {
	let root = short("uninstall");
	let bin = root.join("bin/searchd");
	std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
	std::fs::copy(BIN, &bin).unwrap();
	let data = root.join("data");
	record(&data, &rg_line(), VERSION, true);
	let tree = tree_at(&root);
	let daemon = Daemon::start(serve_cmd(&bin, &data, &tree), &root.join("stderr"));
	daemon.wait_serving(&data);

	let out = Command::new(&bin).arg("uninstall").env("SEARCHD_DIR", &data).output().unwrap();
	assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
	assert!(!data.exists(), "the data folder is still there");
	assert!(!bin.exists(), "the binary is still there");
	let mut daemon = daemon;
	assert!(daemon.finish(Duration::from_secs(30)).is_some(), "the daemon did not exit after being asked to");
}

/// The daemon's own files are private, and a planted symlink is never written
/// through: checked for the log here, since it is opened at start.
#[test]
fn the_log_is_private_and_a_symlink_is_refused() {
	let root = short("log-file");
	let data = root.join("data");
	let tree = tree_at(&root);
	let mut daemon = Daemon::start(serve_cmd(Path::new(BIN), &data, &tree), &root.join("stderr"));
	daemon.finish(Duration::from_secs(60));
	let log = data.join("searchd.log");
	let mode = std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(&log).unwrap().permissions()) & 0o777;
	assert_eq!(mode, 0o600, "the log is not private");

	let other = root.join("other");
	std::fs::create_dir_all(&other).unwrap();
	std::fs::write(other.join("searchd.log"), b"").unwrap();
	std::fs::remove_file(&log).unwrap();
	std::os::unix::fs::symlink(other.join("searchd.log"), &log).unwrap();
	let mut victim = Daemon::start(serve_cmd(Path::new(BIN), &data, &tree), &root.join("stderr2"));
	let status = victim.finish(Duration::from_secs(60)).expect("the daemon must exit when it cannot open its log");
	assert!(!status.success(), "{status}");
	assert_eq!(std::fs::read(other.join("searchd.log")).unwrap(), b"", "the daemon wrote through the symlink");
	assert_eq!(std::fs::read_link(&log).ok().as_deref(), Some(other.join("searchd.log").as_path()));
}
