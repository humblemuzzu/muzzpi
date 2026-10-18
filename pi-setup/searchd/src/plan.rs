//! Which 3-byte chunks a file must contain for a pattern to possibly match
//! in it. The answer may admit files that do not match (the real matcher
//! decides) but never excludes one that does.

use regex_syntax::hir::{Class, Hir, HirKind};

/// A trigram: three ASCII-lowercased bytes, packed.
pub type Tri = u32;

#[derive(Clone, Debug, PartialEq)]
pub enum Q {
	/// No constraint: every file is a candidate.
	All,
	Tri(Tri),
	And(Vec<Q>),
	Or(Vec<Q>),
}

const MAX_SET: usize = 64;
const MAX_CLASS: usize = 8;

pub fn fold(b: u8) -> u8 {
	b.to_ascii_lowercase()
}

pub fn tri(a: u8, b: u8, c: u8) -> Tri {
	(fold(a) as u32) << 16 | (fold(b) as u32) << 8 | fold(c) as u32
}

/// Every trigram of `s` must be present.
fn all_tris(s: &[u8]) -> Q {
	if s.len() < 3 {
		return Q::All;
	}
	let mut t: Vec<Tri> = s.windows(3).map(|w| tri(w[0], w[1], w[2])).collect();
	t.sort_unstable();
	t.dedup();
	and(t.into_iter().map(Q::Tri).collect())
}

fn and(qs: Vec<Q>) -> Q {
	let mut out = Vec::new();
	for q in qs {
		match q {
			Q::All => {}
			Q::And(inner) => out.extend(inner),
			q => out.push(q),
		}
	}
	out.dedup();
	match out.len() {
		0 => Q::All,
		1 => out.pop().unwrap(),
		_ => Q::And(out),
	}
}

fn or(qs: Vec<Q>) -> Q {
	let mut out = Vec::new();
	for q in qs {
		match q {
			Q::All => return Q::All,
			Q::Or(inner) => out.extend(inner),
			q => out.push(q),
		}
	}
	match out.len() {
		0 => Q::All,
		1 => out.pop().unwrap(),
		_ => Q::Or(out),
	}
}

/// What is known about the strings a sub-pattern matches: either all of
/// them (`exact`, a small set), or only a condition every match meets.
struct Info {
	exact: Option<Vec<Vec<u8>>>,
	q: Q,
}

impl Info {
	fn exact(set: Vec<Vec<u8>>) -> Info {
		Info {
			exact: Some(set),
			q: Q::All,
		}
	}

	fn inexact(q: Q) -> Info {
		Info { exact: None, q }
	}

	/// The condition alone, with an exact set turned into "contains one of".
	fn into_q(self) -> Q {
		match self.exact {
			Some(set) => and(vec![self.q, or(set.iter().map(|s| all_tris(s)).collect())]),
			None => self.q,
		}
	}
}

fn dedup(mut v: Vec<Vec<u8>>) -> Vec<Vec<u8>> {
	v.sort_unstable();
	v.dedup();
	v
}

/// A class's members as byte strings, case-folded, when there are few.
fn class_strings(c: &Class) -> Option<Vec<Vec<u8>>> {
	let mut out: Vec<Vec<u8>> = Vec::new();
	match c {
		Class::Unicode(u) => {
			for r in u.ranges() {
				let (s, e) = (r.start() as u32, r.end() as u32);
				if (e - s) as usize >= MAX_CLASS * 4 {
					return None;
				}
				for cp in s..=e {
					let ch = char::from_u32(cp)?;
					let mut buf = [0u8; 4];
					let bytes = ch.encode_utf8(&mut buf).as_bytes();
					out.push(bytes.iter().map(|&b| fold(b)).collect());
				}
			}
		}
		Class::Bytes(b) => {
			for r in b.ranges() {
				if (r.end() - r.start()) as usize >= MAX_CLASS * 4 {
					return None;
				}
				for x in r.start()..=r.end() {
					out.push(vec![fold(x)]);
				}
			}
		}
	}
	let out = dedup(out);
	(out.len() <= MAX_CLASS).then_some(out)
}

fn info(h: &Hir) -> Info {
	match h.kind() {
		HirKind::Empty | HirKind::Look(_) => Info::exact(vec![Vec::new()]),
		HirKind::Literal(l) => Info::exact(vec![l.0.iter().map(|&b| fold(b)).collect()]),
		HirKind::Class(c) => match class_strings(c) {
			Some(set) if !set.is_empty() => Info::exact(set),
			_ => Info::inexact(Q::All),
		},
		HirKind::Capture(c) => info(&c.sub),
		HirKind::Repetition(r) => {
			if r.min == 0 {
				return Info::inexact(Q::All);
			}
			let sub = info(&r.sub);
			if r.min == 1 && r.max == Some(1) {
				return sub;
			}
			Info::inexact(sub.into_q())
		}
		HirKind::Concat(subs) => {
			let mut acc = Info::exact(vec![Vec::new()]);
			for s in subs {
				let next = info(s);
				acc = match (acc.exact, next.exact) {
					(Some(a), Some(b)) if a.len() * b.len() <= MAX_SET => {
						let mut prod = Vec::with_capacity(a.len() * b.len());
						for x in &a {
							for y in &b {
								let mut s = x.clone();
								s.extend_from_slice(y);
								prod.push(s);
							}
						}
						Info {
							exact: Some(dedup(prod)),
							q: and(vec![acc.q, next.q]),
						}
					}
					(ae, be) => {
						let left = Info { exact: ae, q: acc.q }.into_q();
						let right = Info { exact: be, q: next.q }.into_q();
						Info::inexact(and(vec![left, right]))
					}
				};
			}
			acc
		}
		HirKind::Alternation(subs) => {
			let infos: Vec<Info> = subs.iter().map(info).collect();
			let total: usize = infos.iter().map(|i| i.exact.as_ref().map_or(usize::MAX / 2, Vec::len)).sum();
			if infos.iter().all(|i| i.exact.is_some() && i.q == Q::All) && total <= MAX_SET {
				Info::exact(dedup(infos.into_iter().flat_map(|i| i.exact.unwrap()).collect()))
			} else {
				Info::inexact(or(infos.into_iter().map(Info::into_q).collect()))
			}
		}
	}
}

/// The trigram condition for a grep request. Anything the parser cannot
/// handle yields `All`, which only costs speed.
pub fn plan(pattern: &str, literal: bool, ignore_case: bool) -> Q {
	let escaped;
	let pattern = if literal {
		escaped = regex_syntax::escape(pattern);
		escaped.as_str()
	} else {
		pattern
	};
	let hir = regex_syntax::ParserBuilder::new()
		.unicode(true)
		.utf8(false)
		.case_insensitive(ignore_case)
		.multi_line(true)
		.build()
		.parse(pattern);
	match hir {
		Ok(h) => info(&h).into_q(),
		Err(_) => Q::All,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn tris_of(q: &Q) -> Vec<Tri> {
		match q {
			Q::Tri(t) => vec![*t],
			Q::And(v) | Q::Or(v) => v.iter().flat_map(tris_of).collect(),
			Q::All => vec![],
		}
	}

	#[test]
	fn literals_and_alternations_need_their_trigrams() {
		assert_eq!(tris_of(&plan("needle", false, false)).len(), 4);
		assert!(matches!(plan("foo|barbaz", false, false), Q::Or(_)));
		assert_eq!(plan(r"\w+", false, false), Q::All);
		assert_eq!(plan("ab", false, false), Q::All);
		assert_eq!(plan("x*needle", false, false), plan("needle", false, false));
	}

	#[test]
	fn case_insensitive_folds_to_the_same_trigrams() {
		assert_eq!(plan("NEEDLE", false, true), plan("needle", false, false));
	}

	#[test]
	fn the_kelvin_sign_stays_a_candidate_for_k() {
		let q = plan("kelvin", false, true);
		let kelvin = "\u{212a}elvin".as_bytes();
		assert!(matches(&q, &file_tris(kelvin)));
		assert!(matches(&q, &file_tris(b"KELVIN")));
		assert!(!matches(&q, &file_tris(b"melvin")));
	}

	fn file_tris(b: &[u8]) -> Vec<Tri> {
		let mut t: Vec<Tri> = b.windows(3).map(|w| tri(w[0], w[1], w[2])).collect();
		t.sort_unstable();
		t
	}

	fn matches(q: &Q, have: &[Tri]) -> bool {
		match q {
			Q::All => true,
			Q::Tri(t) => have.binary_search(t).is_ok(),
			Q::And(v) => v.iter().all(|q| matches(q, have)),
			Q::Or(v) => v.iter().any(|q| matches(q, have)),
		}
	}
}
