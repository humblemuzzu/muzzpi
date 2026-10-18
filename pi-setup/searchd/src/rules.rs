use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use ignore::WalkBuilder;
use ignore::overrides::{Override, OverrideBuilder};

/// The overrides our tools put before the caller's glob, in rg's order.
pub const TOOL_GLOBS: [&str; 2] = ["!.git", "!.jj"];

/// `rg --hidden --glob '!.git' --glob '!.jj'` as ripgrep's own flag parser
/// configures its walker (crates/core/flags/hiargs.rs `walk_builder`), run
/// with the process cwd at `root`.
pub fn walk_builder(root: &Path) -> WalkBuilder {
	let mut b = WalkBuilder::new(root);
	b.max_depth(None)
		.follow_links(false)
		.max_filesize(None)
		.same_file_system(false)
		.overrides(overrides(root, None).expect("static globs compile"))
		.hidden(false)
		.parents(true)
		.ignore(true)
		.git_global(true)
		.git_ignore(true)
		.git_exclude(true)
		.require_git(true)
		.ignore_case_insensitive(false)
		.current_dir(root);
	b.add_custom_ignore_filename(".rgignore");
	b
}

pub fn overrides(dir: &Path, user: Option<&str>) -> Result<Override, String> {
	let mut b = OverrideBuilder::new(dir);
	for g in TOOL_GLOBS.iter().copied().chain(user) {
		b.add(g).map_err(|e| e.to_string())?;
	}
	b.build().map_err(|e| e.to_string())
}

/// Outside home: the OS, apps, package managers' trees, other volumes and
/// the kernel's own files. Nobody's project lives there.
const SKIP_SYSTEM: [&str; 19] = [
	"/System",
	"/Library",
	"/Applications",
	"/usr",
	"/bin",
	"/sbin",
	"/private",
	"/opt/homebrew",
	"/opt/local",
	"/nix",
	"/Volumes",
	"/dev",
	"/cores",
	"/net",
	"/home",
	"/.Spotlight-V100",
	"/.fseventsd",
	"/.DocumentRevisions-V100",
	"/.Trashes",
];

/// Under home: app data (all of ~/Library, which holds Mail, Messages,
/// browser profiles and caches), toolchains, package caches and the trash.
const SKIP_HOME: [&str; 52] = [
	"Library",
	".Trash",
	"Music/Music",
	"Movies/TV",
	".npm",
	".pnpm-store",
	".yarn/berry/cache",
	".bun/install",
	".deno",
	".nvm",
	".volta",
	".cache",
	".cargo/registry",
	".cargo/git",
	".rustup",
	".pyenv",
	".rbenv",
	".gem",
	".conda",
	"miniconda3",
	"anaconda3",
	".local/share",
	".local/lib",
	".local/pipx",
	".local/state",
	".pub-cache",
	".dartServer",
	"go/pkg",
	".gradle",
	".m2",
	".android",
	".swiftpm",
	".cocoapods",
	".docker",
	".orbstack",
	".colima",
	".lima",
	".ollama",
	".vscode/extensions",
	".cursor/extensions",
	".windsurf/extensions",
	".codex/.tmp",
	".kube/cache",
	// Agent transcripts and undo snapshots: copies of everything said and
	// edited, rewritten all day, and full of pasted tokens.
	".pi/agent/sessions",
	".pi/agent/sessions-sub",
	".pi/file-changes",
	".claude/projects",
	".cursor/projects",
	".grok/marketplace-cache",
	".vite-plus",
	".electron-gyp",
	".config/tokscale/cache",
];

/// `~/.<tool>/<name>`: installed editor extensions, and agents' session logs.
const SKIP_HOME_DOT_CHILDREN: [&str; 4] = ["extensions", "sessions", "archived_sessions", "transcripts"];

/// Folders that hold installed dependencies, caches or build output,
/// outside git repos. A rule only meets a folder rg would enter, so a
/// gitignored node_modules is not skipped but simply absent, as in rg; in a
/// repo, what is not ignored is the project's own (a vendored framework, a
/// committed node_modules) and is indexed like the rest.
const SKIP_NAMES: [&str; 24] = [
	"node_modules",
	"bower_components",
	"jspm_packages",
	".pnpm-store",
	"__pycache__",
	"site-packages",
	".venv",
	".tox",
	".nox",
	".mypy_cache",
	".pytest_cache",
	".ruff_cache",
	".gradle",
	"DerivedData",
	".dart_tool",
	".next",
	".nuxt",
	".svelte-kit",
	".turbo",
	".parcel-cache",
	".angular",
	".terraform",
	".cache",
	"Pods",
];

/// Bundles: an app or framework is one thing to find, not its innards.
const SKIP_SUFFIXES: [&str; 8] = [
	".app",
	".framework",
	".xcframework",
	".dSYM",
	".xcarchive",
	".photoslibrary",
	".kext",
	".appex",
];

/// The folders macOS asks its user to allow the first time anything reads
/// them. Walking into one out of nowhere raises that prompt, so the index
/// leaves them out until a search asks for one.
const PRIVATE: [&str; 3] = ["Desktop", "Documents", "Downloads"];

#[derive(Clone, Default)]
pub struct Gate(Arc<Vec<(PathBuf, AtomicBool)>>);

fn under(abs: &[u8], folder: &[u8]) -> bool {
	abs.starts_with(folder) && (abs.len() == folder.len() || abs[folder.len()] == b'/')
}

impl Gate {
	/// The private folders under `home` that a walk of `root` would enter;
	/// those in `unlocked` start open.
	pub fn load(root: &Path, home: &Path, unlocked: &[PathBuf]) -> Gate {
		Gate(Arc::new(
			PRIVATE
				.iter()
				.map(|n| home.join(n))
				.filter(|p| p.starts_with(root) && p != root)
				.map(|p| {
					let open = unlocked.contains(&p);
					(p, AtomicBool::new(open))
				})
				.collect(),
		))
	}

	/// The private folder `dir` lies in, if no search has asked for it yet.
	pub fn locked(&self, dir: &Path) -> Option<&Path> {
		self.0.iter().find(|(p, open)| !open.load(Ordering::Relaxed) && dir.starts_with(p)).map(|(p, _)| p.as_path())
	}

	/// Opens the private folder `dir` lies in; true only for the call that
	/// opened it.
	pub fn unlock(&self, dir: &Path) -> bool {
		self.0.iter().find(|(p, _)| dir.starts_with(p)).is_some_and(|(_, open)| !open.swap(true, Ordering::SeqCst))
	}

	/// The folders a search has asked for, to be opened again on the next run.
	pub fn unlocked(&self) -> Vec<PathBuf> {
		self.0.iter().filter(|(_, open)| open.load(Ordering::Relaxed)).map(|(p, _)| p.clone()).collect()
	}

	fn closed(&self, abs: &[u8]) -> bool {
		self.0.iter().any(|(p, open)| !open.load(Ordering::Relaxed) && abs == p.as_os_str().as_bytes())
	}

	fn covers(&self, abs: &[u8]) -> bool {
		self.0.iter().any(|(p, open)| !open.load(Ordering::Relaxed) && under(abs, p.as_os_str().as_bytes()))
	}
}

/// Folders the index records but never enters. A query inside one goes to
/// rg; a query in a repo that holds one goes to rg; a query in a folder of
/// folders (home, the disk, a projects folder) answers without them and
/// says how many it left out.
#[derive(Clone)]
pub struct Exclusions {
	paths: Vec<Vec<u8>>,
	names: bool,
	home: Option<PathBuf>,
	gate: Gate,
}

fn skip_name(name: &[u8]) -> bool {
	SKIP_NAMES.iter().any(|n| name == n.as_bytes()) || SKIP_SUFFIXES.iter().any(|s| name.ends_with(s.as_bytes()))
}

impl Exclusions {
	/// `own` is the daemon's data folder: its sockets, cookie and index files
	/// churn with every query and are nobody's search results. `unlocked` are
	/// the private folders a search has already asked for.
	pub fn for_root(root: &Path, home: &Path, own: &Path, unlocked: &[PathBuf]) -> Exclusions {
		let mut paths: Vec<PathBuf> = SKIP_SYSTEM.iter().map(PathBuf::from).collect();
		paths.extend(SKIP_HOME.iter().map(|rel| home.join(rel)));
		paths.push(own.to_path_buf());
		paths.retain(|p| p.starts_with(root) && p != root);
		Exclusions {
			paths: paths.into_iter().map(|p| p.as_os_str().as_bytes().to_vec()).collect(),
			names: true,
			home: home.starts_with(root).then(|| home.to_path_buf()),
			gate: Gate::load(root, home, unlocked),
		}
	}

	fn home_dot_child(&self, abs: &Path) -> bool {
		let Some(rel) = self.home.as_ref().and_then(|h| abs.strip_prefix(h).ok()) else { return false };
		let parts: Vec<&[u8]> = rel.iter().map(|c| c.as_bytes()).collect();
		parts.len() == 2 && parts[0].starts_with(b".") && SKIP_HOME_DOT_CHILDREN.iter().any(|n| parts[1] == n.as_bytes())
	}

	/// The name and bundle rules only, for a tree that is not the disk.
	pub fn names_only() -> Exclusions {
		Exclusions {
			paths: Vec::new(),
			names: true,
			home: None,
			gate: Gate::default(),
		}
	}

	pub fn gate(&self) -> &Gate {
		&self.gate
	}

	/// Whether the walk records folder `abs` and stays out of it.
	pub fn skips(&self, abs: &Path, is_dir: bool) -> bool {
		if !is_dir {
			return false;
		}
		let b = abs.as_os_str().as_bytes();
		self.paths.iter().any(|p| b == p.as_slice())
			|| self.gate.closed(b)
			|| self.home_dot_child(abs)
			|| (self.names && abs.file_name().is_some_and(|n| skip_name(n.as_bytes())) && !self.in_repo(abs))
	}

	/// Whether a folder above `abs` holds `.git`. One in home or at the disk
	/// root (a dotfiles repo) does not count: it would make all of home a repo.
	pub fn in_repo(&self, abs: &Path) -> bool {
		for a in abs.ancestors().skip(1) {
			if a.parent().is_none() || self.home.as_deref() == Some(a) {
				return false;
			}
			if std::fs::symlink_metadata(a.join(".git")).is_ok() {
				return true;
			}
		}
		false
	}

	pub fn home(&self) -> Option<&Path> {
		self.home.as_deref()
	}

	/// True when `abs` is a skipped folder or lies inside one.
	pub fn covers(&self, abs: &Path) -> bool {
		let b = abs.as_os_str().as_bytes();
		if self.paths.iter().any(|p| under(b, p)) || self.gate.covers(b) {
			return true;
		}
		abs.ancestors().any(|a| self.home_dot_child(a))
	}
}

/// rg anchors the global excludes file at its cwd, which for our tools is
/// the search dir, while the index walks from the root. A global rule with a
/// `/` in it can therefore decide differently below some search dirs.
pub struct GlobalExcludes {
	pub files: Vec<PathBuf>,
	/// Every component of a global rule that contains a `/`.
	components: Vec<String>,
	/// The first rule anchored to the cwd (not starting with `**/`) and the file
	/// it came from: every search dir other than the root may decide
	/// differently below one.
	anchored: Option<(String, PathBuf)>,
}

impl GlobalExcludes {
	pub fn load(home: &Path) -> GlobalExcludes {
		let configured = std::process::Command::new("git")
			.args(["config", "--global", "--get", "core.excludesFile"])
			.output()
			.ok()
			.filter(|o| o.status.success())
			.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
			.filter(|s| !s.is_empty());
		let excludes = match configured {
			Some(p) if p.starts_with("~/") => home.join(&p[2..]),
			Some(p) => PathBuf::from(p),
			None => std::env::var_os("XDG_CONFIG_HOME")
				.map(PathBuf::from)
				.unwrap_or_else(|| home.join(".config"))
				.join("git/ignore"),
		};
		GlobalExcludes::at(home, &excludes)
	}

	/// The rules written in `excludes`, read as a search below a folder meets
	/// them: `home` is where the two git config files live, which are watched
	/// for a change of the excludes file itself.
	fn at(home: &Path, excludes: &Path) -> GlobalExcludes {
		let mut files = vec![home.join(".gitconfig"), home.join(".config/git/config")];
		let mut components = Vec::new();
		let mut anchored = None;
		if let Ok(text) = std::fs::read_to_string(excludes) {
			for line in text.lines() {
				let rule = line.trim_end().trim_start_matches('!');
				if rule.is_empty() || rule.starts_with('#') {
					continue;
				}
				let body = rule.trim_end_matches('/');
				if !body.contains('/') {
					continue;
				}
				let floating = body.strip_prefix("**/");
				if floating.is_none() && anchored.is_none() {
					anchored = Some((rule.to_string(), excludes.to_path_buf()));
				}
				for c in floating.unwrap_or(body).split('/') {
					if c != "**" && !c.is_empty() {
						components.push(c.to_string());
					}
				}
			}
		}
		files.push(excludes.to_path_buf());
		GlobalExcludes {
			files,
			components,
			anchored,
		}
	}

	pub fn none() -> GlobalExcludes {
		GlobalExcludes {
			files: Vec::new(),
			components: Vec::new(),
			anchored: None,
		}
	}

	/// The rule that makes every search below another folder go to rg, and the
	/// file it is written in.
	pub fn anchored(&self) -> Option<(&str, &Path)> {
		self.anchored.as_ref().map(|(rule, file)| (rule.as_str(), file.as_path()))
	}

	/// Whether results under `dir` can be taken from the root's walk.
	pub fn agrees_below(&self, root: &Path, dir: &Path) -> bool {
		if dir == root {
			return true;
		}
		if self.anchored.is_some() {
			return false;
		}
		if self.components.is_empty() {
			return true;
		}
		let globs: Vec<globset::GlobMatcher> = self
			.components
			.iter()
			.filter_map(|c| globset::Glob::new(c).ok().map(|g| g.compile_matcher()))
			.collect();
		!dir.components().any(|c| globs.iter().any(|g| g.is_match(c.as_os_str())))
	}
}

pub const IGNORE_FILES: [&str; 3] = [".gitignore", ".ignore", ".rgignore"];

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn what_the_disk_index_skips() {
		let home = Path::new("/Users/u");
		let e = Exclusions::for_root(Path::new("/"), home, Path::new("/Users/u/.pi/agent/searchd"), &[]);
		let skips = |p: &str| e.skips(Path::new(p), true);
		for p in [
			"/System",
			"/opt/homebrew",
			"/Users/u/Library",
			"/Users/u/.npm",
			"/Users/u/.pi/file-changes",
			"/Users/u/.pi/agent/sessions",
			"/Users/u/.pi/agent/searchd",
			"/Users/u/.trae/extensions",
			"/Users/u/.grok/sessions",
			"/Users/u/.codex/archived_sessions",
			"/Users/u/Documents/app/node_modules",
			"/Users/u/Documents/app/Tool.app",
			"/Users/u/Documents/app/.venv",
		] {
			assert!(skips(p), "{p} should be skipped");
		}
		for p in [
			"/Users/u",
			"/Users/u/Documents/app/extensions",
			"/Users/u/Documents/app/sessions",
			"/Users/u/.trae",
			"/Users/u/.trae/settings",
			"/Users/u/.pi/agent",
			"/Users/u/.config",
			"/opt",
		] {
			assert!(!skips(p), "{p} should be indexed");
		}
		assert!(!e.skips(Path::new("/Users/u/Documents/node_modules"), false), "a file is never skipped");
		assert!(e.covers(Path::new("/Users/u/.trae/extensions/x/y")));
		assert!(e.covers(Path::new("/Users/u/Library/Caches/x")));
		assert!(!e.covers(Path::new("/Users/u/projects/app/src")));
	}

	/// A walk from `/` must not read a folder macOS shows a prompt for; a search
	/// that asks for one opens it, and an opened one stays open on the next run.
	#[test]
	fn privacy_folders_are_gated_until_asked_for() {
		let home = Path::new("/Users/u");
		let root = Path::new("/");
		let e = Exclusions::for_root(root, home, Path::new("/Users/u/.own"), &[]);
		for p in ["/Users/u/Desktop", "/Users/u/Documents", "/Users/u/Downloads"] {
			assert!(e.skips(Path::new(p), true), "{p} must not be entered on a walk from /");
			assert!(e.covers(Path::new(&format!("{p}/notes.txt"))), "{p} must cover what is inside it");
		}
		assert!(e.gate().locked(Path::new("/Users/u/Documents/tax/2025")).is_some());
		assert!(e.gate().unlock(Path::new("/Users/u/Documents/tax")));
		assert!(!e.gate().unlock(Path::new("/Users/u/Documents")));
		assert!(!e.skips(Path::new("/Users/u/Documents"), true), "an asked-for folder is indexed");
		assert!(!e.covers(Path::new("/Users/u/Documents/tax")));
		assert!(e.skips(Path::new("/Users/u/Desktop"), true), "the others stay gated");
		assert_eq!(e.gate().unlocked(), vec![home.join("Documents")]);

		let again = Exclusions::for_root(root, home, Path::new("/Users/u/.own"), &[home.join("Documents")]);
		assert!(!again.skips(Path::new("/Users/u/Documents"), true), "an unlocked folder must survive a restart");
		assert!(!Exclusions::names_only().skips(Path::new("/Users/u/Documents"), true), "names_only gates nothing");
	}

	/// A global rule with a `/` that is not `**/`-prefixed is anchored to the
	/// folder rg runs in, so every search below another folder may miss it: the
	/// refusal is kept, and the rule and its file are recorded so it can be said
	/// out loud instead of silently costing every search.
	#[test]
	fn an_anchored_global_rule_is_named_and_refuses_searches_below_a_folder() {
		use crate::selftest::{cleanup, temp_root};

		let root = temp_root("global-ignore");
		let home = root.join("home");
		std::fs::create_dir_all(&home).unwrap();
		let excludes = home.join("ignore");
		std::fs::write(&excludes, b"# comment\n*.log\ntarget/debug\nlogs/*.txt\n").unwrap();
		let g = GlobalExcludes::at(&home, &excludes);
		let (rule, file) = g.anchored().expect("the anchored rule must be named");
		assert_eq!(rule, "target/debug", "the first anchored rule is the one named");
		assert_eq!(file, excludes.as_path());
		assert!(!g.agrees_below(&root, &home.join("proj")), "a search below another folder may decide differently");
		assert!(g.agrees_below(&root, &root), "a search at the root decides the same");

		std::fs::write(&excludes, b"*.log\n**/target/debug\n**/logs/*.txt\n").unwrap();
		let g = GlobalExcludes::at(&home, &excludes);
		assert!(g.anchored().is_none(), "a floating rule anchors nothing");
		assert!(g.agrees_below(&root, &home.join("proj")), "a floating rule decides the same anywhere");
		assert!(!g.agrees_below(&root, &home.join("target/debug")), "a folder a rule names may differ below it");
		assert!(GlobalExcludes::none().anchored().is_none());
		cleanup(&root);
	}

	#[test]
	fn name_rules_stop_at_a_repo() {
		let root = std::env::temp_dir().join(format!("searchd-rules-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&root);
		for d in ["home/.git", "home/proj/.git", "home/proj/node_modules", "home/loose/node_modules"] {
			std::fs::create_dir_all(root.join(d)).unwrap();
		}
		let home = root.join("home");
		let e = Exclusions::for_root(&root, &home, &root.join("own"), &[]);
		assert!(!e.skips(&home.join("proj/node_modules"), true), "a repo's own node_modules is indexed");
		assert!(e.skips(&home.join("loose/node_modules"), true), "a .git in home does not make home a repo");
		let _ = std::fs::remove_dir_all(&root);
	}
}
