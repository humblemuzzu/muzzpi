//! FSEvents stream, directory granularity, replayable by event id.
//!
//! Adapted from fsearch (https://github.com/noahdunnagan/fsearch,
//! src/fsevents.rs), MIT License, Copyright (c) 2026 Noah Dunnagan.
//! Changed: paths and exclusions, a bounded change set instead of a channel,
//! a flush, the newest event id delivered.

use std::collections::HashSet;
use std::ffi::{CStr, CString, c_void};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};

pub const MUST_SCAN_SUBDIRS: u32 = 0x1;
pub const USER_DROPPED: u32 = 0x2;
pub const KERNEL_DROPPED: u32 = 0x4;
const CREATE_FLAG_NO_DEFER: u32 = 0x2;

/// Distinct folders the feed holds before it forgets them and asks for a
/// rebuild instead: past this the change set is the whole disk anyway.
const MAX_PENDING: usize = 100_000;

/// What the feed has to fold in. A folder changed twice is one entry, so the
/// set is bounded by the number of folders, not by the number of events.
#[derive(Default)]
pub struct Pending {
	relist: HashSet<Vec<u8>>,
	rewalk: HashSet<Vec<u8>>,
	cookie: u64,
	batches: u64,
	pub dropped: bool,
}

/// One wake-up's worth of changes.
pub struct Changes {
	pub relist: Vec<Vec<u8>>,
	pub rewalk: Vec<Vec<u8>>,
	/// The newest event id of a cookie event in the set, or 0.
	pub cookie: u64,
	pub batches: u64,
	pub dropped: bool,
}

/// The change set, shared by the feed's callback and the thread that folds it in.
pub type Queue = Arc<(Mutex<Pending>, Condvar)>;

impl Pending {
	pub fn empty(&self) -> bool {
		self.relist.is_empty() && self.rewalk.is_empty() && self.cookie == 0 && !self.dropped
	}

	pub(crate) fn merge(&mut self, path: &[u8], flags: u32, id: u64, cookie: &[u8]) {
		let mut end = path.len();
		while end > 1 && path[end - 1] == b'/' {
			end -= 1;
		}
		let p = &path[..end];
		if p == cookie {
			self.cookie = self.cookie.max(id);
			return;
		}
		if self.dropped || flags & (USER_DROPPED | KERNEL_DROPPED) != 0 {
			self.dropped = true;
			return;
		}
		if self.relist.len() + self.rewalk.len() >= MAX_PENDING {
			self.relist.clear();
			self.rewalk.clear();
			self.dropped = true;
			return;
		}
		if flags & MUST_SCAN_SUBDIRS != 0 {
			self.rewalk.insert(p.to_vec());
		} else {
			self.relist.insert(p.to_vec());
		}
	}

	pub fn take(&mut self) -> Changes {
		let mut relist: Vec<Vec<u8>> = self.relist.drain().collect();
		let mut rewalk: Vec<Vec<u8>> = self.rewalk.drain().collect();
		relist.sort_unstable();
		rewalk.sort_unstable();
		Changes {
			relist,
			rewalk,
			cookie: std::mem::take(&mut self.cookie),
			batches: std::mem::take(&mut self.batches),
			dropped: std::mem::take(&mut self.dropped),
		}
	}
}

struct Info {
	queue: Queue,
	cookie: Vec<u8>,
	last_id: Arc<AtomicU64>,
}

#[repr(C)]
struct Context {
	version: isize,
	info: *mut c_void,
	retain: *const c_void,
	release: *const c_void,
	copy_description: *const c_void,
}

type Callback = extern "C" fn(*mut c_void, *mut c_void, usize, *mut c_void, *const u32, *const u64);

/// CoreServices is loaded on first use, not linked: only the daemon watches.
struct Api {
	create: unsafe extern "C" fn(*const c_void, Callback, *const Context, *const c_void, u64, f64, u32) -> *mut c_void,
	set_queue: unsafe extern "C" fn(*mut c_void, *mut c_void),
	flush_sync: unsafe extern "C" fn(*mut c_void),
	exclude: unsafe extern "C" fn(*mut c_void, *const c_void) -> u8,
	start: unsafe extern "C" fn(*mut c_void) -> u8,
	stop: unsafe extern "C" fn(*mut c_void),
	invalidate: unsafe extern "C" fn(*mut c_void),
	release: unsafe extern "C" fn(*mut c_void),
	current_id: unsafe extern "C" fn() -> u64,
	cf_release: unsafe extern "C" fn(*const c_void),
	string: unsafe extern "C" fn(*const c_void, *const i8, u32) -> *const c_void,
	array: unsafe extern "C" fn(*const c_void, *const *const c_void, isize, *const c_void) -> *const c_void,
	array_callbacks: *const c_void,
}

// Function pointers and a constant's address: fine to share.
unsafe impl Send for Api {}
unsafe impl Sync for Api {}

fn api() -> &'static Api {
	static API: std::sync::OnceLock<Api> = std::sync::OnceLock::new();
	API.get_or_init(|| unsafe {
		let open = |path: &CStr| {
			let h = libc::dlopen(path.as_ptr(), libc::RTLD_LAZY);
			assert!(!h.is_null(), "cannot load {path:?}");
			h
		};
		let (cs, cf) = (
			open(c"/System/Library/Frameworks/CoreServices.framework/CoreServices"),
			open(c"/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"),
		);
		Api {
			create: sym(cs, c"FSEventStreamCreate"),
			set_queue: sym(cs, c"FSEventStreamSetDispatchQueue"),
			flush_sync: sym(cs, c"FSEventStreamFlushSync"),
			exclude: sym(cs, c"FSEventStreamSetExclusionPaths"),
			start: sym(cs, c"FSEventStreamStart"),
			stop: sym(cs, c"FSEventStreamStop"),
			invalidate: sym(cs, c"FSEventStreamInvalidate"),
			release: sym(cs, c"FSEventStreamRelease"),
			current_id: sym(cs, c"FSEventsGetCurrentEventId"),
			cf_release: sym(cf, c"CFRelease"),
			string: sym(cf, c"CFStringCreateWithCString"),
			array: sym(cf, c"CFArrayCreate"),
			array_callbacks: sym(cf, c"kCFTypeArrayCallBacks"),
		}
	})
}

/// A symbol of a loaded image, as `T` (a function pointer, or a data
/// symbol's address).
unsafe fn sym<T>(h: *mut c_void, name: &CStr) -> T {
	let p = unsafe { libc::dlsym(h, name.as_ptr()) };
	assert!(!p.is_null(), "missing {name:?}");
	unsafe { std::mem::transmute_copy(&p) }
}

/// The newest event id on the system.
pub fn current_id() -> u64 {
	unsafe { (api().current_id)() }
}

unsafe extern "C" {
	fn dispatch_queue_create(label: *const i8, attr: *const c_void) -> *mut c_void;
	fn dispatch_queue_attr_make_with_qos_class(attr: *const c_void, qos: u32, relative_priority: i32) -> *const c_void;
	fn dispatch_release(object: *mut c_void);
}

extern "C" fn on_events(_s: *mut c_void, info: *mut c_void, n: usize, paths: *mut c_void, flags: *const u32, ids: *const u64) {
	let info = unsafe { &*(info as *const Info) };
	let paths = paths as *const *const i8;
	let (lock, cv) = &*info.queue;
	let mut last = 0u64;
	let mut q = lock.lock().unwrap_or_else(|e| e.into_inner());
	q.batches += 1;
	for i in 0..n {
		unsafe {
			q.merge(CStr::from_ptr(*paths.add(i)).to_bytes(), *flags.add(i), *ids.add(i), &info.cookie);
			last = last.max(*ids.add(i));
		}
	}
	let any = !q.empty();
	drop(q);
	info.last_id.fetch_max(last, Ordering::SeqCst);
	if any {
		cv.notify_one();
	}
}

extern "C" fn release_info(info: *const c_void) {
	if !info.is_null() {
		drop(unsafe { Box::from_raw(info as *mut Info) });
	}
}

/// A running stream and the dispatch queue it runs on; dropping it stops it.
/// The queue is ours until the stream is gone: FSEvents does not say that it
/// keeps one of its own.
pub struct Stream {
	s: *mut c_void,
	q: *mut c_void,
}

// The stream is only started, flushed and stopped; FSEvents serializes these.
unsafe impl Send for Stream {}
unsafe impl Sync for Stream {}

impl Stream {
	/// Returns once every event that happened before the call has been
	/// handed to the callback.
	pub fn flush(&self) {
		unsafe { (api().flush_sync)(self.s) }
	}
}

impl Drop for Stream {
	fn drop(&mut self) {
		unsafe {
			let a = api();
			if !self.q.is_null() {
				(a.stop)(self.s);
				(a.invalidate)(self.s);
			}
			(a.release)(self.s);
			if !self.q.is_null() {
				dispatch_release(self.q);
			}
		}
	}
}

/// A created stream, or none: FSEvents refuses a path it cannot watch, and a
/// null one must not be given a queue or started.
fn from_created(s: *mut c_void) -> Option<Stream> {
	(!s.is_null()).then_some(Stream { s, q: std::ptr::null_mut() })
}

/// A CFArray of path strings, or None for no paths.
unsafe fn cf_paths(a: &Api, paths: &[Vec<u8>]) -> Option<*const c_void> {
	let names: Vec<CString> = paths.iter().filter_map(|p| CString::new(p.clone()).ok()).collect();
	if names.is_empty() {
		return None;
	}
	unsafe {
		let strings: Vec<*const c_void> = names.iter().map(|n| (a.string)(std::ptr::null(), n.as_ptr(), 0x0800_0100)).collect();
		let arr = (a.array)(std::ptr::null(), strings.as_ptr(), strings.len() as isize, a.array_callbacks);
		for cf in strings {
			(a.cf_release)(cf);
		}
		Some(arr)
	}
}

/// Watch `paths`, less `exclude`, from event id `since`: every batch the
/// callback receives is merged into `queue`, and its newest id kept in
/// `last_id`. An event whose path is `cookie` is counted, not folded in.
pub fn watch(
	paths: &[Vec<u8>],
	exclude: &[Vec<u8>],
	since: u64,
	latency: f64,
	queue: Queue,
	cookie: &[u8],
	last_id: Arc<AtomicU64>,
) -> Option<Stream> {
	let a = api();
	unsafe {
		let arr = cf_paths(a, paths)?;
		let info = Box::into_raw(Box::new(Info { queue, cookie: cookie.to_vec(), last_id })) as *mut c_void;
		let ctx = Context {
			version: 0,
			info,
			retain: std::ptr::null(),
			release: release_info as *const c_void,
			copy_description: std::ptr::null(),
		};
		let s = (a.create)(std::ptr::null(), on_events, &ctx, arr, since, latency, CREATE_FLAG_NO_DEFER);
		(a.cf_release)(arr);
		if s.is_null() {
			drop(Box::from_raw(info as *mut Info));
			return None;
		}
		let mut stream = from_created(s)?;
		if let Some(ex) = cf_paths(a, exclude) {
			(a.exclude)(stream.s, ex);
			(a.cf_release)(ex);
		}
		let qos = libc::qos_class_t::QOS_CLASS_UTILITY as u32;
		stream.q = dispatch_queue_create(
			c"searchd.fsevents".as_ptr(),
			dispatch_queue_attr_make_with_qos_class(std::ptr::null(), qos, 0),
		);
		(a.set_queue)(stream.s, stream.q);
		(a.start)(stream.s);
		Some(stream)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn flood(p: &mut Pending, paths: impl Iterator<Item = Vec<u8>>) {
		for path in paths {
			p.merge(&path, 0, 1, b"/cookie");
		}
	}

	#[test]
	fn a_flood_of_events_is_a_handful_of_folders() {
		let mut p = Pending::default();
		flood(&mut p, (0..1_000_000u32).map(|i| format!("/f{}", i % 10).into_bytes()));
		assert_eq!(p.relist.len(), 10);
		assert!(!p.dropped);
	}

	#[test]
	fn a_change_set_past_the_cap_is_dropped() {
		let mut p = Pending::default();
		flood(&mut p, (0..MAX_PENDING + 5_000).map(|i| format!("/d{i}").into_bytes()));
		assert!(p.dropped, "a flood past the cap must ask for a rebuild");
		assert!(p.relist.is_empty() && p.rewalk.is_empty(), "the sets must be cleared");
		let c = p.take();
		assert!(c.dropped && c.relist.is_empty() && c.rewalk.is_empty());
		assert!(!p.dropped, "a taken drop is forgotten");
	}

	#[test]
	fn a_cookie_is_known_by_its_newest_event_id() {
		let mut p = Pending::default();
		for id in [7, 300, 42] {
			p.merge(b"/cookie/", 0, id, b"/cookie");
		}
		p.merge(b"/elsewhere/", 0, 999, b"/cookie");
		p.merge(b"/deep", MUST_SCAN_SUBDIRS, 1000, b"/cookie");
		let c = p.take();
		assert_eq!(c.cookie, 300);
		assert_eq!(c.relist, vec![b"/elsewhere".to_vec()]);
		assert_eq!(c.rewalk, vec![b"/deep".to_vec()]);
		assert_eq!(p.take().cookie, 0);
	}

	#[test]
	fn a_null_stream_is_not_a_stream() {
		assert!(from_created(std::ptr::null_mut()).is_none());
	}
}
