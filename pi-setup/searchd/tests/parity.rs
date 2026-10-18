#[test]
fn every_answered_query_matches_rg() {
	let report = searchd::selftest::run("rg");
	assert!(report.failures.is_empty(), "differs from rg:\n{}", report.failures.join("\n"));
	assert!(report.nonempty > 200, "too few comparisons had results: {}", report.nonempty);
	assert!(report.compared > report.fallbacks.len(), "most queries were handed to rg");
}
