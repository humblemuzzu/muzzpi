//! What one query allocates. Its own test binary because the count needs a
//! global allocator, and a test that measures allocations cannot share a
//! process with tests that run their own work.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

use searchd::query;
use searchd::rules::{Exclusions, overrides};
use searchd::selftest::{cleanup, temp_root};
use searchd::tree::{Tree, WalkOptions};

struct Counting;

static ALLOCS: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
	unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
		ALLOCS.fetch_add(1, Ordering::Relaxed);
		unsafe { System.alloc(layout) }
	}

	unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
		unsafe { System.dealloc(ptr, layout) }
	}

	unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new: usize) -> *mut u8 {
		ALLOCS.fetch_add(1, Ordering::Relaxed);
		unsafe { System.realloc(ptr, layout, new) }
	}
}

#[global_allocator]
static A: Counting = Counting;

/// A home-wide grep lists millions of files: a string for each one, kept until
/// the search ends, is hundreds of megabytes. The traversal walks one folder's
/// names in one buffer and an entry costs nothing but its node id.
#[test]
fn listing_a_flat_folder_of_twenty_thousand_files_allocates_almost_nothing() {
	let root = temp_root("allocs");
	for i in 0..20_000 {
		std::fs::write(root.join(format!("f{i:05}.txt")), b"needle\n").unwrap();
	}
	let excl = Exclusions::names_only();
	let tree = Tree::walk(&root, &WalkOptions { threads: 4, background: false, exclusions: &excl }).unwrap();
	let ov = overrides(&root, Some("*")).unwrap();
	assert_eq!(tree.nodes.len(), 20_001, "the fixture is not what the test lists");

	let before = ALLOCS.load(Ordering::Relaxed);
	let set = query::file_set(&tree, 0, Some(&ov)).expect("listed");
	let allocs = ALLOCS.load(Ordering::Relaxed) - before;
	assert_eq!(set.nodes.len(), 20_000, "the listing must hold every file");
	assert!(allocs < 1_000, "{allocs} allocations to list 20000 files, one per entry at least");
	cleanup(&root);
}
