use std::collections::BTreeSet;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::Ordering;

use searchd::content::{Content, DocIn, FileSig, UNLIMITED};
use searchd::engine::index_rules;
use searchd::query::GrepRequest;
use searchd::selftest::{content_dir, engine_with, temp_root};

/// Credential locations that only count under home (here, the root).
const HOME_SECRETS: [&str; 2] = [".wrangler/config/default.toml", ".cargo/credentials.toml"];

const SECRET_FILES: [&str; 21] = [
	"p/.zshrc",
	"p/.zshrc.bak-20260730",
	"p/.zshrc.swp",
	"p/.zsh_history",
	"p/.codex/auth.json",
	"p/.claude/.credentials.json",
	"p/.gemini/oauth_creds.json",
	"p/.broski/token",
	"p/vendor/credentials/token.json",
	"p/Secrets/prod.yaml",
	"p/.env",
	"p/.env.production",
	"p/.envrc",
	"p/.envrc.local",
	"p/keys/id_ed25519_github",
	"p/.dev.vars",
	"p/id_ed25519",
	"p/certs/server.PEM",
	"p/sub/.npmrc",
	"p/aws/credentials",
	"p/secrets.yaml",
];

fn write(root: &Path, rel: &str, body: &str) {
	let p = root.join(rel);
	std::fs::create_dir_all(p.parent().unwrap()).unwrap();
	std::fs::write(p, body).unwrap();
}

fn sig(size: u64) -> FileSig {
	FileSig {
		size,
		mtime: 0,
		ctime: 0,
		ino: 0,
	}
}

fn segments(dir: &Path) -> Vec<(String, Vec<u8>)> {
	std::fs::read_dir(dir)
		.unwrap()
		.flatten()
		.map(|e| (e.file_name().to_string_lossy().into_owned(), std::fs::read(e.path()).unwrap()))
		.collect()
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
	hay.windows(needle.len()).any(|w| w == needle)
}

#[test]
fn credential_files_never_reach_the_index_yet_grep_still_finds_them() {
	let root = temp_root("secrets");
	for f in SECRET_FILES.iter().chain(&HOME_SECRETS) {
		write(&root, f, "token qq7zx_secret\n");
	}
	write(&root, "p/ok.txt", "plain qq7zx_plain\n");
	let e = engine_with(&root, 50_000);
	let segs = segments(&content_dir(&root));
	assert!(segs.iter().any(|(_, b)| contains(b, b"p/ok.txt")), "the plain file was not indexed");
	for (name, bytes) in &segs {
		for f in SECRET_FILES.iter().chain(&HOME_SECRETS) {
			assert!(!contains(bytes, f.as_bytes()), "{name} holds {f}");
		}
	}

	let rg = Command::new("rg")
		.args(["-l", "--hidden", "qq7zx", "."])
		.current_dir(root.join("p"))
		.output()
		.unwrap();
	let want: BTreeSet<String> = String::from_utf8_lossy(&rg.stdout).lines().map(|l| l.trim_start_matches("./").to_string()).collect();
	let mut buf = Vec::new();
	let req = GrepRequest {
		pattern: "qq7zx",
		literal: false,
		ignore_case: false,
		context: 0,
		limit: u64::MAX,
	};
	e.grep(&root.join("p"), None, &req, &mut buf).unwrap();
	let got: BTreeSet<String> = buf
		.split(|&b| b == b'\n')
		.filter_map(|l| serde_json::from_slice::<serde_json::Value>(l).ok())
		.filter(|v| v["type"] == "match")
		.map(|v| v["data"]["path"]["text"].as_str().unwrap().trim_start_matches("./").to_string())
		.collect();
	assert_eq!(got, want, "grep must still read the credential files, as rg does");
	assert_eq!(want.len(), SECRET_FILES.len() + 1);
}

#[test]
fn a_segment_written_under_other_rules_is_deleted() {
	let dir = temp_root("rules");
	let path = dir.join("a.txt");
	std::fs::write(&path, "x").unwrap();
	let docs = [DocIn { path: &path, sig: sig(1), tris: &[1, 2] }];
	Content::open(&dir, 1, UNLIMITED).write_segment(&docs).unwrap();
	assert_eq!(Content::open(&dir, 1, UNLIMITED).segs.iter().flatten().count(), 1);
	assert_eq!(Content::open(&dir, 2, UNLIMITED).segs.iter().flatten().count(), 0);
	assert!(segments(&dir).iter().all(|(n, _)| !n.starts_with("seg-")), "the stale segment file is still on disk");
}

#[test]
fn a_segment_holding_a_secret_is_purged_at_start_up() {
	let root = temp_root("taint");
	write(&root, "p/.env", "token qq7zx\n");
	write(&root, "p/ok.txt", "plain qq7zx\n");
	// What an earlier build, before a rule existed, might have written.
	let cdir = content_dir(&root);
	let env = root.join("p/.env");
	let ok = root.join("p/ok.txt");
	let docs = [
		DocIn { path: &env, sig: sig(12), tris: &[7] },
		DocIn { path: &ok, sig: sig(12), tris: &[7] },
	];
	Content::open(&cdir, index_rules(&root), UNLIMITED).write_segment(&docs).unwrap();
	let e = engine_with(&root, 50_000);
	assert_eq!(e.counters.segments_purged.load(Ordering::Relaxed), 1);
	for (name, bytes) in segments(&cdir) {
		assert!(!contains(&bytes, b"p/.env"), "{name} still holds p/.env");
	}
}
