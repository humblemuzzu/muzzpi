import { describe, expect, test } from "bun:test";
import { allPostIds, parsePosts, parseUsers, snowflakeTime } from "./parse";

/** the layouts below are copied from real tool output, with the people and words replaced. */

const SEARCH = `Main Post:
- [post:0] ID: 2112803291327504763
- Conversation ID: 2112786063467188710
- Author: Ana Dev - @ana_dev
- Avatar: https://pbs.twimg.com/profile_images/1/a.jpg
- Bio: builds things
second bio line
- Timestamp: Wed, 21 Oct 2026 07:08:53 GMT
- Engagement: Likes=12, Reposts=1, Quotes=0, Replies=3, Bookmarks=0, Views=N/A
- Content: first line

- a bullet that is not a field
- Note: also not a field
last line

---

Main Post:
- [post:1] ID: 2059002180481204461
- Conversation ID: 2059002180481204461
- Author: Ben - @ben_b
- Timestamp: Mon, 25 May 2026 20:02:28 GMT
- Engagement: Likes=7078, Reposts=964, Quotes=130, Replies=504, Bookmarks=12983, Views=63257872
- Quoted Post:
  - [post:0] ID: 2058973760708091907
  - Author: Launch Team - @launch
  - Timestamp: Mon, 25 May 2026 18:09:33 GMT
  - Engagement: Likes=9832, Reposts=1411, Quotes=411, Replies=1163, Bookmarks=2306, Views=73233791
  - Media: Yes (1 item)
   - Item 1: video - URL: https://video.twimg.com/q.mp4 (duration: 43543 ms)
  - Content: The quoted announcement.
  
  Second quoted paragraph.
- Media: Yes (2 items)
 - Item 1: photo - URL: https://pbs.twimg.com/media/one.jpg
 - Item 2: video - URL: https://video.twimg.com/two.mp4 (duration: 348888 ms)
- Content: The quoting post.`;

const THREAD_ROOT = `[post:0]
Main Post (Requested Post):
- ID: 2112666467712073815
- Author: Root Person - @root
- Timestamp: Tue, 20 Oct 2026 22:05:12 GMT
- Engagement: Likes=61265, Reposts=4938, Quotes=757, Replies=3566, Bookmarks=1985, Views=3735640
- Media: Yes (1 item)
 - Item 1: photo - URL: https://pbs.twimg.com/media/root.jpg
- Content: The root post.  
  - ID: 2112670894606909459
  - Author: First Reply - @reply_one
  - Bio: a bio
  that continues
  - Timestamp: Tue, 20 Oct 2026 22:22:47 GMT
  - Engagement: Likes=559, Reposts=6, Quotes=2, Replies=37, Bookmarks=3, Views=31108
  - Content: Reply one.
  
  - ID: 2112682780538577011
  - Author: Second Reply - @reply_two
  - Timestamp: Tue, 20 Oct 2026 23:10:01 GMT
  - Engagement: Likes=266, Reposts=27, Quotes=2, Replies=10, Bookmarks=8, Views=14866
  - Media: Yes (1 item)
   - Item 1: photo - URL: https://pbs.twimg.com/media/r2.jpg
  - Content: Reply two.`;

const THREAD_OF_A_REPLY = `[post:0]
Main Post:
- ID: 2090441945260670999
- Conversation ID: 2090441945260670999
- Author: Parent - @parent
- Timestamp: Thu, 20 Aug 2026 14:12:52 GMT
- Engagement: Likes=675, Reposts=15, Quotes=0, Replies=42, Bookmarks=40, Views=64402
- Quoted Post:
  - ID: 2090438712610242609
  - Author: Quoted - @quoted
  - Timestamp: Thu, 20 Aug 2026 14:00:02 GMT
  - Engagement: Likes=2662, Reposts=106, Quotes=79, Replies=112, Bookmarks=334, Views=614667
  - Content: The quoted scoop.
- Content: The parent's take.  (Requested Post):
  - ID: 2090550747196739706
  - Author: Asker - @asker
  - Timestamp: Thu, 20 Aug 2026 21:25:13 GMT
  - Engagement: Likes=1, Reposts=0, Quotes=0, Replies=0, Bookmarks=0, Views=52
  - Content: The reply that was fetched.`;

const USERS = `[X User Result 0]:
- ID: 33836629
- Name: Some Researcher - @researcher
- Avatar: https://pbs.twimg.com/profile_images/a.jpg
- Followers: 4382318
- Verified: Blue Verified

---

[X User Result 1]:
- ID: 1673010386138972167
- Name: Researcher Alt - @researcher_alt
- Bio: an alt account
on two lines
- Followers: 569`;

describe("parsePosts: search results", () => {
	const posts = parsePosts(SEARCH);

	test("one post per card, ids and authors", () => {
		expect(posts.map((p) => [p.id, p.username, p.name])).toEqual([
			["2112803291327504763", "ana_dev", "Ana Dev"],
			["2059002180481204461", "ben_b", "Ben"],
		]);
		expect(posts[0].url).toBe("https://x.com/ana_dev/status/2112803291327504763");
	});

	test("content keeps its own dash lines and blank lines; bio keeps its continuation", () => {
		expect(posts[0].text).toBe("first line\n\n- a bullet that is not a field\n- Note: also not a field\nlast line");
		expect(posts[0].bio).toBe("builds things\nsecond bio line");
	});

	test("engagement numbers, with N/A left out", () => {
		expect(posts[0].engagement).toEqual({ likes: 12, reposts: 1, quotes: 0, replies: 3, bookmarks: 0, views: undefined });
		expect(posts[1].engagement.views).toBe(63257872);
	});

	test("timestamps become ISO UTC", () => {
		expect(posts[0].createdAt).toBe("2026-10-21T07:08:53Z");
	});

	test("the quoted post is nested with its own media, and media goes to the post it sits under", () => {
		const [, quoting] = posts;
		expect(quoting.quoted?.id).toBe("2058973760708091907");
		expect(quoting.quoted?.text).toBe("The quoted announcement.\n\nSecond quoted paragraph.");
		expect(quoting.quoted?.media).toEqual([{ type: "video", url: "https://video.twimg.com/q.mp4", durationMs: 43543 }]);
		expect(quoting.media.map((m) => m.url)).toEqual(["https://pbs.twimg.com/media/one.jpg", "https://video.twimg.com/two.mp4"]);
		expect(quoting.text).toBe("The quoting post.");
		expect(quoting.replies).toEqual([]);
	});
});

describe("parsePosts: threads", () => {
	test("a fetched root holds its replies, each with its own fields", () => {
		const [root] = parsePosts(THREAD_ROOT);
		expect(root.role).toBe("requested");
		expect(root.text).toBe("The root post.");
		expect(root.media).toHaveLength(1);
		expect(root.replies.map((r) => [r.id, r.username, r.role, r.text])).toEqual([
			["2112670894606909459", "reply_one", "reply", "Reply one."],
			["2112682780538577011", "reply_two", "reply", "Reply two."],
		]);
		expect(root.replies[0].bio).toBe("a bio\nthat continues");
		expect(root.replies[1].media[0].url).toBe("https://pbs.twimg.com/media/r2.jpg");
	});

	test("a fetched reply comes back under its parent, after the quoted post", () => {
		const [parent] = parsePosts(THREAD_OF_A_REPLY);
		expect(parent.role).toBe("parent");
		expect(parent.text).toBe("The parent's take.");
		expect(parent.quoted?.id).toBe("2090438712610242609");
		expect(parent.replies.map((r) => [r.id, r.role, r.text])).toEqual([["2090550747196739706", "requested", "The reply that was fetched."]]);
		expect([...allPostIds([parent])].sort()).toEqual(["2090438712610242609", "2090441945260670999", "2090550747196739706"]);
	});
});

describe("parseUsers", () => {
	test("user cards, with name and handle split and bio continued", () => {
		expect(parseUsers(USERS)).toEqual([
			{ id: "33836629", username: "researcher", name: "Some Researcher", url: "https://x.com/researcher", followers: 4382318, verified: "Blue Verified" },
			{ id: "1673010386138972167", username: "researcher_alt", name: "Researcher Alt", url: "https://x.com/researcher_alt", bio: "an alt account\non two lines", followers: 569, verified: undefined },
		]);
		expect(parsePosts(USERS)).toEqual([]);
	});
});

test("snowflake ids carry their creation time", () => {
	expect(snowflakeTime("2112666467712073815")).toBe("2026-10-20T22:05:12Z");
	expect(snowflakeTime("33836629")).toBeUndefined();
});

test("a bare --- inside a post is part of its text, not the end of the card", () => {
	const raw = "Main Post:\n- ID: 1111111111111111111\n- Author: A - @a\n- Content: part one\n---\npart two\n\n---\n\nMain Post:\n- ID: 2222222222222222222\n- Author: B - @b\n- Content: next";
	const posts = parsePosts(raw);
	expect(posts.map((p) => p.text)).toEqual(["part one\n---\npart two", "next"]);
});

test("a Quoted Post line with a value is not waiting for a quote card", () => {
	const raw = "Main Post:\n- ID: 1111111111111111111\n- Quoted Post: unavailable\n- Content: top\n  - ID: 2222222222222222222\n  - Content: a reply";
	const [post] = parsePosts(raw);
	expect(post.quoted).toBeUndefined();
	expect(post.replies.map((r) => r.id)).toEqual(["2222222222222222222"]);
});

test("text that is not tool output parses to nothing", () => {
	expect(parsePosts("Here are the latest posts I found:\n1. something")).toEqual([]);
	expect(parsePosts("NO RESULTS")).toEqual([]);
});
