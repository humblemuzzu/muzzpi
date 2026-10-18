use std::ffi::OsStr;
use std::io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;

use crate::engine::Engine;
use crate::query::GrepRequest;

const IDLE_EXIT: Duration = Duration::from_secs(4 * 3600);
/// The longest socket path macOS accepts (`sun_path` is 104 bytes).
const SUN_PATH_MAX: usize = 103;
/// A client that stops reading must not hold a connection thread forever.
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// The client clamps a request too, but a request can come from anywhere.
const MAX_LIMIT: u64 = 10_000;
const MAX_CONTEXT: usize = 100;
const MAX_TEXT: usize = 4096;
/// An exit code of its own for a data folder held by something that does not answer.
pub const LOCKED_UNANSWERED: u8 = 3;

const LOG_MAX: u64 = 1 << 20;
const LOG_KEEP: u64 = 256 << 10;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
	pub op: String,
	pub dir: Option<String>,
	pub glob: Option<String>,
	pub pattern: Option<String>,
	pub literal: Option<bool>,
	pub ignore_case: Option<bool>,
	pub context: Option<usize>,
	pub limit: Option<u64>,
	pub offset: Option<u64>,
}

pub fn data_dir() -> PathBuf {
	if let Some(d) = std::env::var_os("SEARCHD_DIR") {
		return PathBuf::from(d);
	}
	std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default().join(".pi/agent/searchd")
}

/// The home folder the daemon may index under: absolute, real, and this user's.
/// Without one, `root` would fall back to `/` and the whole disk would be
/// indexed under a home that is not there.
pub fn checked_home(home: Option<&OsStr>) -> Result<PathBuf, String> {
	let Some(home) = home else { return Err("HOME is not set".into()) };
	let home = Path::new(home);
	if !home.is_absolute() {
		return Err(format!("HOME is not an absolute path: {}", home.display()));
	}
	let meta = std::fs::metadata(home).map_err(|e| format!("HOME {}: {e}", home.display()))?;
	if !meta.is_dir() {
		return Err(format!("HOME is not a directory: {}", home.display()));
	}
	if meta.uid() != unsafe { libc::getuid() } {
		return Err(format!("HOME is not owned by this user: {}", home.display()));
	}
	Ok(std::fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf()))
}

/// What a data folder must be, from its own metadata: a real directory (never
/// a symlink, whose target a chmod would reach), this user's, 0700.
fn private_dir(meta: &std::fs::Metadata, dir: &Path) -> Result<(), String> {
	if !meta.is_dir() {
		return Err(format!("{} is not a directory", dir.display()));
	}
	if meta.uid() != unsafe { libc::getuid() } {
		return Err(format!("{} is not owned by this user", dir.display()));
	}
	let mode = meta.permissions().mode() & 0o777;
	if mode != 0o700 {
		return Err(format!("{} is mode {mode:o}, not 700", dir.display()));
	}
	Ok(())
}

/// Where the data folder has to be, from the environment alone: SEARCHD_DIR if
/// set, else a private folder under a home that is worth indexing.
pub fn data_dir_for(searchd_dir: Option<&OsStr>, home: Option<&OsStr>) -> Result<PathBuf, String> {
	let dir = match searchd_dir {
		Some(d) => PathBuf::from(d),
		None => checked_home(home)?.join(".pi/agent/searchd"),
	};
	if !dir.is_absolute() {
		return Err(format!("the data folder must be an absolute path: {}", dir.display()));
	}
	Ok(dir)
}

/// The data folder, created private to the user (0700).
pub fn ensure_data_dir() -> std::io::Result<PathBuf> {
	let dir = data_dir_for(std::env::var_os("SEARCHD_DIR").as_deref(), std::env::var_os("HOME").as_deref())
		.map_err(std::io::Error::other)?;
	std::fs::create_dir_all(&dir)?;
	if !std::fs::symlink_metadata(&dir)?.is_dir() {
		return Err(std::io::Error::other(format!("{} is not a directory", dir.display())));
	}
	std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
	private_dir(&std::fs::symlink_metadata(&dir)?, &dir).map_err(std::io::Error::other)?;
	std::fs::canonicalize(&dir)
}

/// A file the daemon owns: 0600, appended to or rewritten, and never opened
/// through a symlink planted at its path.
fn open_owned(path: &Path, append: bool) -> std::io::Result<std::fs::File> {
	let mut options = std::fs::OpenOptions::new();
	options.create(true).write(true).mode(0o600).custom_flags(libc::O_NOFOLLOW);
	if append {
		options.append(true);
	} else {
		options.truncate(true);
	}
	let file = options.open(path)?;
	file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
	Ok(file)
}

pub fn stamp_path(dir: &Path) -> PathBuf {
	dir.join("selftest.json")
}

/// The recorded selftest, if there is one that parses.
pub fn read_stamp(dir: &Path) -> Option<serde_json::Value> {
	let text = std::fs::read_to_string(stamp_path(dir)).ok()?;
	serde_json::from_str(&text).ok()
}

/// Records what this build answered for the rg it was checked against.
pub fn write_stamp(dir: &Path, rg: Option<&str>, ok: bool) -> std::io::Result<()> {
	let body = serde_json::json!({ "rg": rg, "searchd": env!("CARGO_PKG_VERSION"), "ok": ok }).to_string();
	open_owned(&stamp_path(dir), false)?.write_all(body.as_bytes())
}

/// Keeps a log that grew past its cap to its last quarter, on a line boundary.
pub fn rotate_log(path: &Path) -> std::io::Result<()> {
	let mut log = match std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(path) {
		Ok(f) => f,
		Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
		Err(e) => return Err(e),
	};
	let len = log.metadata()?.len();
	if len <= LOG_MAX {
		return Ok(());
	}
	log.seek(SeekFrom::Start(len - LOG_KEEP))?;
	let mut tail = Vec::with_capacity(LOG_KEEP as usize);
	log.read_to_end(&mut tail)?;
	let start = tail.iter().position(|&b| b == b'\n').map_or(0, |i| i + 1);
	open_owned(path, false)?.write_all(&tail[start..])
}

/// Everything the daemon prints from now on — every `eprintln!`, the panic
/// hook — lands in its log instead of the void its parent handed it.
pub fn log_stderr(dir: &Path) -> std::io::Result<()> {
	let path = dir.join("searchd.log");
	rotate_log(&path)?;
	let log = open_owned(&path, true)?;
	if unsafe { libc::dup2(log.as_raw_fd(), libc::STDERR_FILENO) } < 0 {
		return Err(std::io::Error::last_os_error());
	}
	Ok(())
}

/// iCloud Drive and Dropbox leave the bytes of an unused file on their servers
/// (a dataless placeholder); reading one downloads it. The daemon never wants
/// that, so the kernel is told to fail such a read.
pub fn refuse_dataless_reads() -> Result<(), String> {
	const IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES: libc::c_int = 3;
	const IOPOL_SCOPE_PROCESS: libc::c_int = 0;
	const IOPOL_MATERIALIZE_DATALESS_FILES_OFF: libc::c_int = 1;
	unsafe extern "C" {
		fn setiopolicy_np(iotype: libc::c_int, scope: libc::c_int, policy: libc::c_int) -> libc::c_int;
	}
	let refusal = IOPOL_MATERIALIZE_DATALESS_FILES_OFF;
	let scope = IOPOL_SCOPE_PROCESS;
	if unsafe { setiopolicy_np(IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES, scope, refusal) } == 0 {
		return Ok(());
	}
	Err(format!("setiopolicy_np: {}", std::io::Error::last_os_error()))
}

pub fn socket_path(dir: &Path) -> PathBuf {
	dir.join("searchd.sock")
}

fn now_secs() -> u64 {
	SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn exe_of(pid: libc::pid_t) -> Option<PathBuf> {
	let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
	let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
	(n > 0).then(|| PathBuf::from(OsStr::from_bytes(&buf[..n as usize])))
}

/// The process macOS holds responsible for `pid` (the app it was launched
/// from, whose privacy permissions it runs under), with its executable.
pub fn responsible(pid: libc::pid_t) -> Option<(libc::pid_t, PathBuf)> {
	type Lookup = unsafe extern "C" fn(libc::pid_t) -> libc::pid_t;
	static LOOKUP: OnceLock<Option<Lookup>> = OnceLock::new();
	let lookup = (*LOOKUP.get_or_init(|| {
		let p = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"responsibility_get_pid_responsible_for_pid".as_ptr()) };
		(!p.is_null()).then(|| unsafe { std::mem::transmute::<*mut libc::c_void, Lookup>(p) })
	}))?;
	let r = unsafe { lookup(pid) };
	if r <= 0 {
		return None;
	}
	exe_of(r).map(|exe| (r, exe))
}

fn peer_pid(conn: &UnixStream) -> Option<libc::pid_t> {
	const SOL_LOCAL: libc::c_int = 0;
	const LOCAL_PEERPID: libc::c_int = 0x002;
	let mut pid: libc::pid_t = 0;
	let mut len = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
	let ok = unsafe { libc::getsockopt(conn.as_raw_fd(), SOL_LOCAL, LOCAL_PEERPID, (&raw mut pid).cast(), &mut len) } == 0;
	(ok && pid > 0).then_some(pid)
}

pub type Origin = (libc::pid_t, PathBuf);

/// A client of the same responsible process already holds the daemon's
/// folder permissions, so the daemon lends nobody access macOS denied them.
pub fn same_app(own: Option<&Origin>, peer: Option<&Origin>) -> bool {
	matches!((own, peer), (Some(a), Some(b)) if a == b)
}

/// Taken before anything touches the data folder: opening the content
/// index deletes stale files there. None: a daemon already holds it.
pub fn take_lock() -> std::io::Result<Option<std::fs::File>> {
	take_lock_in(&ensure_data_dir()?)
}

fn take_lock_in(dir: &Path) -> std::io::Result<Option<std::fs::File>> {
	let lock = open_owned(&dir.join("lock"), true)?;
	if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
		return Ok(None);
	}
	Ok(Some(lock))
}

/// Whether a daemon on this data folder answers a status request.
pub fn answers_status(dir: &Path) -> bool {
	let Ok(mut sock) = UnixStream::connect(socket_path(dir)) else { return false };
	if sock.set_read_timeout(Some(Duration::from_secs(2))).is_err() || sock.write_all(b"{\"op\":\"status\"}\n").is_err() {
		return false;
	}
	let _ = sock.shutdown(std::net::Shutdown::Write);
	let mut line = String::new();
	BufReader::new(sock).read_line(&mut line).is_ok() && line.starts_with("{\"type\":\"searchd_")
}

/// Asks a running daemon to shut down. False when nothing answered.
pub fn shut_down(dir: &Path) -> bool {
	let Ok(mut sock) = UnixStream::connect(socket_path(dir)) else { return false };
	let _ = sock.set_read_timeout(Some(Duration::from_secs(2)));
	let _ = sock.write_all(b"{\"op\":\"shutdown\"}\n");
	let _ = sock.shutdown(std::net::Shutdown::Write);
	let mut line = String::new();
	BufReader::new(sock).read_line(&mut line).is_ok() && line.starts_with("{\"type\":\"searchd_")
}

/// Waits until no daemon holds the data folder's lock.
pub fn wait_unlocked(dir: &Path, limit: Duration) -> bool {
	let until = Instant::now() + limit;
	loop {
		match take_lock_in(dir) {
			Ok(Some(lock)) => {
				drop(lock);
				return true;
			}
			Ok(None) if Instant::now() < until => std::thread::sleep(Duration::from_millis(50)),
			Ok(None) => return false,
			Err(_) => return false,
		}
	}
}

const MAX_CLIENTS: usize = 64;
const REQUEST_WAIT: Duration = Duration::from_secs(2);
const REQUEST_MAX: u64 = 1 << 20;

pub fn serve(engine: Arc<Engine>, _lock: std::fs::File) -> std::io::Result<()> {
	let me = unsafe { libc::getpid() };
	// Any program can be its own responsible process, so such a match proves
	// nothing: a daemon in that state trusts nobody, and indexes for nobody.
	let Some(own) = responsible(me).filter(|(pid, _)| *pid != me) else {
		return Err(std::io::Error::other(
			"macOS names no app responsible for this daemon, so it could borrow nobody's permissions; nothing is indexed",
		));
	};
	let dir = ensure_data_dir()?;
	let sock = socket_path(&dir);
	if sock.as_os_str().len() > SUN_PATH_MAX {
		return Err(std::io::Error::other(format!(
			"socket path too long for macOS: {}",
			sock.display()
		)));
	}
	let _ = std::fs::remove_file(&sock);
	let old = unsafe { libc::umask(0o177) };
	let listener = UnixListener::bind(&sock);
	unsafe { libc::umask(old) };
	let listener = listener?;
	std::fs::set_permissions(&sock, std::fs::Permissions::from_mode(0o600))?;

	{
		let e = engine.clone();
		std::thread::Builder::new()
			.name("searchd-build".into())
			.spawn(move || e.build(true))?;
	}
	let last = Arc::new(AtomicU64::new(now_secs()));
	{
		let last = last.clone();
		let own = own.clone();
		std::thread::spawn(move || {
			loop {
				std::thread::sleep(Duration::from_secs(60));
				if now_secs().saturating_sub(last.load(Ordering::Relaxed)) > IDLE_EXIT.as_secs() {
					std::process::exit(0);
				}
				// The permissions it runs under are that app's: when the app quits,
				// so does the daemon, and the next search starts one under its own.
				if exe_of(own.0).as_ref() != Some(&own.1) {
					std::process::exit(0);
				}
			}
		});
	}
	let uid = unsafe { libc::getuid() };
	let active = Arc::new(AtomicUsize::new(0));
	for conn in listener.incoming() {
		let Ok(conn) = conn else { continue };
		if peer_uid(&conn) != Some(uid) {
			continue;
		}
		let peer = peer_pid(&conn).and_then(responsible);
		let trusted = same_app(Some(&own), peer.as_ref());
		if trusted {
			last.store(now_secs(), Ordering::Relaxed);
		}
		if active.fetch_add(1, Ordering::SeqCst) >= MAX_CLIENTS {
			active.fetch_sub(1, Ordering::SeqCst);
			continue;
		}
		let e = engine.clone();
		let done = active.clone();
		let spawned = std::thread::Builder::new().name("searchd-conn".into()).spawn(move || {
			handle(&e, conn, trusted);
			done.fetch_sub(1, Ordering::SeqCst);
		});
		if spawned.is_err() {
			active.fetch_sub(1, Ordering::SeqCst);
		}
	}
	Ok(())
}

fn peer_uid(conn: &UnixStream) -> Option<u32> {
	let mut uid: libc::uid_t = 0;
	let mut gid: libc::gid_t = 0;
	(unsafe { libc::getpeereid(conn.as_raw_fd(), &mut uid, &mut gid) } == 0).then_some(uid)
}

fn line(out: &mut impl Write, v: &serde_json::Value) -> std::io::Result<()> {
	serde_json::to_writer(&mut *out, v)?;
	out.write_all(b"\n")
}

/// A protocol line. `type` always comes first: the client tells these from
/// rg's own JSON lines by that prefix, and serde_json sorts keys.
fn control(out: &mut impl Write, kind: &str, fields: serde_json::Value) -> std::io::Result<()> {
	let body = fields.to_string();
	let rest = body.strip_prefix('{').unwrap_or("}");
	let sep = if rest == "}" { "" } else { "," };
	writeln!(out, "{{\"type\":\"{kind}\"{sep}{rest}")
}

fn handle(engine: &Arc<Engine>, conn: UnixStream, trusted: bool) {
	// A client that has already closed refuses a timeout here (EINVAL on macOS);
	// the request it sent is still in the buffer and is answered.
	let _ = conn.set_read_timeout(Some(REQUEST_WAIT));
	let _ = conn.set_write_timeout(Some(WRITE_TIMEOUT));
	let mut reader = BufReader::new(match conn.try_clone() {
		Ok(c) => c.take(REQUEST_MAX),
		Err(_) => return,
	});
	let mut req_line = String::new();
	if reader.read_line(&mut req_line).is_err() {
		return;
	}
	let mut out = BufWriter::with_capacity(64 * 1024, conn);
	let req: Request = match serde_json::from_str(&req_line) {
		Ok(r) => r,
		Err(e) => {
			let _ = control(
				&mut out,
				"searchd_fallback",
				serde_json::json!({"reason": format!("bad request: {e}")}),
			);
			return;
		}
	};
	if !trusted && !matches!(req.op.as_str(), "status" | "shutdown") {
		let _ = control(
			&mut out,
			"searchd_fallback",
			serde_json::json!({"reason": "the client runs under another app than searchd"}),
		);
		return;
	}
	if control(&mut out, "searchd_ack", serde_json::json!({})).is_err() || out.flush().is_err() {
		return;
	}
	let _ = respond(engine, &req, &mut out);
	let _ = out.flush();
	if req.op == "shutdown" {
		std::process::exit(0);
	}
}

pub fn respond(engine: &Arc<Engine>, req: &Request, out: &mut impl Write) -> std::io::Result<()> {
	let fallback = |out: &mut dyn Write, reason: String| {
		let mut out = out;
		control(&mut out, "searchd_fallback", serde_json::json!({"reason": reason}))
	};
	match req.op.as_str() {
		"status" => line(out, &engine.status()),
		"shutdown" => control(out, "searchd_end", serde_json::json!({"exit": 0})),
		"rebuild" => {
			eprintln!("searchd: rebuild asked for by a client");
			engine.rebuild_in_background();
			control(out, "searchd_end", serde_json::json!({"exit": 0}))
		}
		"find" => {
			let (Some(dir), Some(glob)) = (&req.dir, &req.glob) else {
				return fallback(out, "find needs dir and glob".into());
			};
			if glob.len() > MAX_TEXT {
				return fallback(out, "the glob is too long".into());
			}
			let dir = match std::fs::canonicalize(dir) {
				Ok(d) => d,
				Err(e) => return fallback(out, format!("{dir}: {e}")),
			};
			match engine.find(&dir, glob) {
				Ok(r) => {
					// Only the page the tool shows: a paginated slice, or the head
					// and tail of the newest-first list around a gap.
					let total = r.paths.len();
					let limit = req.limit.map_or(total, |l| (l as usize).min(MAX_LIMIT as usize));
					let offset = req.offset.unwrap_or(0) as usize;
					let (shown, head): (Vec<&String>, usize) = if offset > 0 {
						let page: Vec<&String> = r.paths.iter().skip(offset).take(limit).collect();
						let n = page.len();
						(page, n)
					} else if total > limit {
						let half = limit / 2;
						(r.paths[..half].iter().chain(r.paths[total - half..].iter()).collect(), half)
					} else {
						(r.paths.iter().collect(), total)
					};
					for p in shown {
						serde_json::to_writer(&mut *out, p)?;
						out.write_all(b"\n")?;
					}
					let end = serde_json::json!({"exit": r.exit, "skippedAreas": r.skipped_areas, "unreadable": r.unreadable, "total": total, "head": head});
					drop(r);
					if total > 20_000 {
						crate::engine::release_memory();
					}
					control(out, "searchd_end", end)
				}
				Err(reason) => fallback(out, reason),
			}
		}
		"grep" => {
			let (Some(dir), Some(pattern)) = (&req.dir, &req.pattern) else {
				return fallback(out, "grep needs dir and pattern".into());
			};
			if pattern.len() > MAX_TEXT {
				return fallback(out, "the pattern is too long".into());
			}
			if req.glob.as_deref().is_some_and(|g| g.len() > MAX_TEXT) {
				return fallback(out, "the glob is too long".into());
			}
			let dir = match std::fs::canonicalize(dir) {
				Ok(d) if d.is_dir() => d,
				Ok(_) => return fallback(out, "a single file is searched by rg".into()),
				Err(e) => return fallback(out, format!("{dir}: {e}")),
			};
			let g = GrepRequest {
				pattern,
				literal: req.literal.unwrap_or(false),
				ignore_case: req.ignore_case.unwrap_or(false),
				context: req.context.unwrap_or(0).min(MAX_CONTEXT),
				limit: req.limit.unwrap_or(u64::MAX).min(MAX_LIMIT),
			};
			match engine.grep(&dir, req.glob.as_deref(), &g, out) {
				Ok(r) => control(
					out,
					"searchd_end",
					serde_json::json!({"exit": r.exit, "skippedAreas": r.skipped_areas, "skippedFiles": r.skipped_files, "searched": r.searched, "unreadable": r.unreadable}),
				),
				Err(reason) => fallback(out, reason),
			}
		}
		other => fallback(out, format!("unknown op {other}")),
	}
}

#[cfg(test)]
mod tests {
	use std::os::unix::fs::DirBuilderExt;

	use super::*;
	use crate::selftest::temp_root;

	fn engine_at(root: &Path) -> Arc<Engine> {
		let e = Engine::new(crate::engine::Options {
			root: root.to_path_buf(),
			home: root.to_path_buf(),
			threads: 1,
			own_dir: None,
			exact_max_dirs: crate::engine::EXACT_MAX_DIRS,
			scan_first: 4,
			cookie_dir: root.join(".live"),
			content_dir: None,
			index_under: root.to_path_buf(),
			budget: crate::content::UNLIMITED,
			quiet_window: Duration::ZERO,
			rebuild_interval: Duration::from_secs(600),
		});
		e.build(false);
		e
	}

	fn ask(engine: &Arc<Engine>, request: &str, trusted: bool) -> String {
		let (mut client, conn) = UnixStream::pair().unwrap();
		let request = request.to_string();
		// Read while the daemon writes: a socket buffer is far smaller than an
		// answer about ten thousand files.
		let reader = std::thread::spawn(move || {
			client.write_all(request.as_bytes()).unwrap();
			client.shutdown(std::net::Shutdown::Write).unwrap();
			let mut out = String::new();
			client.read_to_string(&mut out).unwrap();
			out
		});
		handle(engine, conn, trusted);
		reader.join().unwrap()
	}

	#[test]
	fn only_a_client_of_the_same_app_may_search() {
		let app = (100, PathBuf::from("/Applications/Ghostty.app/Contents/MacOS/ghostty"));
		let other = (200, PathBuf::from("/Applications/Other.app/Contents/MacOS/other"));
		let relaunched = (300, app.1.clone());
		assert!(same_app(Some(&app), Some(&app)));
		assert!(!same_app(Some(&app), Some(&other)));
		assert!(!same_app(Some(&app), Some(&relaunched)), "same executable, another process");
		assert!(!same_app(Some(&app), None));
		assert!(!same_app(None, Some(&app)), "a daemon responsible for itself trusts nobody");
		assert!(!same_app(None, None));
	}

	#[test]
	fn a_client_of_another_app_reads_nothing() {
		let root = temp_root("trust");
		let engine = engine_at(&root);
		let dir = root.display();
		for op in [
			format!(r#"{{"op":"find","dir":"{dir}","glob":"*"}}"#),
			format!(r#"{{"op":"grep","dir":"{dir}","pattern":"x"}}"#),
			r#"{"op":"rebuild"}"#.to_string(),
			r#"{"op":"anything-new"}"#.to_string(),
		] {
			let out = ask(&engine, &format!("{op}\n"), false);
			assert!(out.starts_with(r#"{"type":"searchd_fallback""#) && !out.contains("searchd_ack"), "{op}: {out}");
		}
		let out = ask(&engine, "{\"op\":\"status\"}\n", false);
		assert!(out.starts_with(r#"{"type":"searchd_ack""#), "status: {out}");
		let out = ask(&engine, &format!(r#"{{"op":"find","dir":"{dir}","glob":"*"}}"#), true);
		assert!(out.starts_with(r#"{"type":"searchd_ack""#), "trusted find: {out}");
	}

	#[test]
	fn macos_names_who_is_responsible_for_this_process() {
		let me = unsafe { libc::getpid() };
		assert!(responsible(me).is_some_and(|(pid, exe)| pid > 0 && exe.is_absolute()));
	}

	/// Reading an iCloud or Dropbox placeholder downloads it; the whole point of
	/// the policy is that the kernel refuses instead.
	#[test]
	fn dataless_files_are_never_downloaded_by_a_read() {
		refuse_dataless_reads().expect("setiopolicy_np must succeed in this process");
	}

	/// Without a home the root falls back to `/` and the whole disk is indexed;
	/// a data folder that is a symlink or readable by others is not ours.
	#[test]
	fn the_daemon_refuses_a_home_or_data_folder_it_cannot_trust() {
		assert!(checked_home(None).unwrap_err().contains("HOME is not set"));
		assert!(checked_home(Some(OsStr::new("relative/home"))).unwrap_err().contains("absolute"));
		assert!(data_dir_for(Some(OsStr::new("relative/dir")), None).unwrap_err().contains("absolute"));
		assert!(data_dir_for(None, None).unwrap_err().contains("HOME is not set"));
		let root = temp_root("home");
		let file = root.join("file");
		std::fs::write(&file, b"x").unwrap();
		assert!(checked_home(Some(file.as_os_str())).unwrap_err().contains("not a directory"));
		assert_eq!(checked_home(Some(root.as_os_str())).unwrap(), std::fs::canonicalize(&*root).unwrap());
		assert_eq!(data_dir_for(None, Some(root.as_os_str())).unwrap(), root.join(".pi/agent/searchd"));
	}

	#[test]
	fn a_data_folder_must_be_a_private_real_directory() {
		let root = temp_root("data-dir");
		let good = root.join("good");
		std::fs::DirBuilder::new().mode(0o700).create(&good).unwrap();
		assert!(private_dir(&std::fs::symlink_metadata(&good).unwrap(), &good).is_ok());
		let open = root.join("open");
		std::fs::DirBuilder::new().mode(0o755).create(&open).unwrap();
		assert!(private_dir(&std::fs::symlink_metadata(&open).unwrap(), &open).unwrap_err().contains("not 700"));
		let link = root.join("link");
		std::os::unix::fs::symlink(&good, &link).unwrap();
		assert!(private_dir(&std::fs::symlink_metadata(&link).unwrap(), &link).unwrap_err().contains("not a directory"));
		let file = root.join("file");
		std::fs::write(&file, b"x").unwrap();
		assert!(private_dir(&std::fs::symlink_metadata(&file).unwrap(), &file).is_err());
	}

	/// A symlink where the daemon writes its own files is a way into another
	/// file; none of them may be opened through it.
	#[test]
	fn a_symlink_planted_in_the_data_folder_stops_every_open() {
		let root = temp_root("nofollow");
		let data = root.join("data");
		std::fs::DirBuilder::new().mode(0o700).create(&data).unwrap();
		let victim = root.join("victim.txt");
		std::fs::write(&victim, "untouched\n").unwrap();
		for name in ["lock", "selftest.json", "searchd.log"] {
			std::os::unix::fs::symlink(&victim, data.join(name)).unwrap();
		}
		assert!(take_lock_in(&data).is_err(), "the lock was opened through a symlink");
		assert!(write_stamp(&data, Some("rg 1.0"), true).is_err(), "the stamp was written through a symlink");
		assert!(log_stderr(&data).is_err(), "the log was opened through a symlink");
		assert_eq!(std::fs::read_to_string(&victim).unwrap(), "untouched\n", "a write went through the symlink");
	}

	#[test]
	fn a_stamp_an_older_build_left_readable_is_made_private() {
		let root = temp_root("stamp-mode");
		let data = root.join("data");
		std::fs::DirBuilder::new().mode(0o700).create(&data).unwrap();
		std::fs::write(stamp_path(&data), "{}").unwrap();
		std::fs::set_permissions(stamp_path(&data), std::fs::Permissions::from_mode(0o644)).unwrap();
		write_stamp(&data, Some("rg 1.0"), true).unwrap();
		let mode = std::fs::metadata(stamp_path(&data)).unwrap().permissions().mode() & 0o777;
		assert_eq!(mode, 0o600);
	}

	#[test]
	fn the_log_keeps_its_tail() {
		let root = temp_root("log-rotate");
		let path = root.join("searchd.log");
		let mut body = String::new();
		for i in 0..40_000 {
			body.push_str(&format!("line {i} ......................................................\n"));
		}
		std::fs::write(&path, &body).unwrap();
		assert!(body.len() as u64 > LOG_MAX);
		rotate_log(&path).unwrap();
		let after = std::fs::read_to_string(&path).unwrap();
		assert!(after.len() as u64 <= LOG_KEEP, "{} bytes kept", after.len());
		assert!(after.ends_with("line 39999 ......................................................\n"));
		assert!(!after.contains("line 0 "), "the head of the log was kept");
	}

	#[test]
	fn a_pattern_or_glob_past_the_cap_goes_to_rg() {
		let root = temp_root("too-long");
		std::fs::create_dir_all(root.join("r")).unwrap();
		std::fs::write(root.join("r/a.txt"), "needle here\n").unwrap();
		let engine = engine_at(&root);
		let dir = root.join("r").display().to_string();
		let long = "n".repeat(MAX_TEXT + 1);
		let out = ask(&engine, &format!(r#"{{"op":"grep","dir":"{dir}","pattern":"{long}"}}"#), true);
		assert!(out.contains("the pattern is too long"), "{out}");
		let out = ask(&engine, &format!(r#"{{"op":"find","dir":"{dir}","glob":"{long}"}}"#), true);
		assert!(out.contains("the glob is too long"), "{out}");
		let out = ask(&engine, &format!(r#"{{"op":"grep","dir":"{dir}","pattern":"needle","glob":"{long}"}}"#), true);
		assert!(out.contains("the glob is too long"), "{out}");
	}

	#[test]
	fn a_context_wider_than_the_cap_is_clamped() {
		let root = temp_root("context-cap");
		std::fs::create_dir_all(root.join("r")).unwrap();
		let mut body = String::new();
		for i in 0..400 {
			body.push_str(if i == 200 { "needle\n" } else { "filler\n" });
		}
		std::fs::write(root.join("r/a.txt"), body).unwrap();
		let engine = engine_at(&root);
		let dir = root.join("r").display().to_string();
		let out = ask(&engine, &format!(r#"{{"op":"grep","dir":"{dir}","pattern":"needle","context":1000}}"#), true);
		// One match with its context on each side, plus the begin and end lines.
		let lines = out.lines().filter(|l| !l.starts_with(r#"{"type":"searchd_"#)).count();
		assert!(lines <= 2 * MAX_CONTEXT + 3, "{lines} lines around one match: the context was not clamped");
	}

	#[test]
	fn a_find_limit_above_the_cap_is_clamped() {
		let root = temp_root("limit-cap");
		let dir = root.join("many");
		std::fs::create_dir_all(&dir).unwrap();
		for i in 0..10_050 {
			std::fs::write(dir.join(format!("f{i}.txt")), b"").unwrap();
		}
		let engine = engine_at(&root);
		let out = ask(&engine, &format!(r#"{{"op":"find","dir":"{}","glob":"*","limit":20000}}"#, dir.display()), true);
		let end = out.lines().last().unwrap();
		assert!(end.contains("\"total\":10050"), "{end}");
		let paths = out.lines().filter(|l| !l.starts_with(r#"{"type":"searchd_"#)).count();
		assert!(paths <= MAX_LIMIT as usize, "{paths} paths written for a limit of {MAX_LIMIT}");
	}

	/// A client that stops reading must not hold a connection thread: the write
	/// gives up instead of blocking forever.
	#[test]
	fn a_client_that_never_reads_does_not_hold_the_connection() {
		let root = temp_root("write-timeout");
		std::fs::create_dir_all(root.join("r")).unwrap();
		let mut body = String::new();
		for i in 0..40_000 {
			body.push_str(&format!("needle line {i} with padding so the answer cannot fit in a socket buffer\n"));
		}
		std::fs::write(root.join("r/big.txt"), body).unwrap();
		let engine = engine_at(&root);
		let (mut client, conn) = UnixStream::pair().unwrap();
		let small: libc::c_int = 4096;
		unsafe {
			libc::setsockopt(
				conn.as_raw_fd(),
				libc::SOL_SOCKET,
				libc::SO_SNDBUF,
				(&raw const small).cast(),
				std::mem::size_of::<libc::c_int>() as libc::socklen_t,
			)
		};
		let request = format!("{{\"op\":\"grep\",\"dir\":\"{}\",\"pattern\":\"needle\"}}\n", root.join("r").display());
		client.write_all(request.as_bytes()).unwrap();
		client.shutdown(std::net::Shutdown::Write).unwrap();
		let started = Instant::now();
		let handler = std::thread::spawn(move || handle(&engine, conn, true));
		while !handler.is_finished() && started.elapsed() < WRITE_TIMEOUT * 6 {
			std::thread::sleep(Duration::from_millis(50));
		}
		assert!(handler.is_finished(), "the handler is still writing to a client that never reads");
		let _ = handler.join();
	}
}
