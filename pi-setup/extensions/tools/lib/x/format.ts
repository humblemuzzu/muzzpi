/** X posts and users as text a model reads: one header line of facts, the link, then the words. */

import type { XEngagement, XPost, XUser } from "./parse";

const count = (n: number) => n.toLocaleString("en-US");

function when(iso: string | undefined): string | undefined {
	return iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : undefined;
}

function engagementText(e: XEngagement): string | undefined {
	const parts = [
		e.likes !== undefined && `${count(e.likes)} likes`,
		e.reposts !== undefined && `${count(e.reposts)} reposts`,
		e.replies !== undefined && `${count(e.replies)} replies`,
		e.quotes ? `${count(e.quotes)} quotes` : undefined,
		e.views !== undefined && `${count(e.views)} views`,
	].filter(Boolean);
	return parts.length ? parts.join(", ") : undefined;
}

export function postHeader(post: XPost): string {
	const who = post.username ? `@${post.username}${post.name ? ` (${post.name})` : ""}` : (post.name ?? "unknown author");
	return [who, when(post.createdAt), engagementText(post.engagement)].filter(Boolean).join(" · ");
}

function postLines(post: XPost, indent: string): string[] {
	const lines = [`${indent}${postHeader(post)}`];
	const link = post.conversationId && post.conversationId !== post.id
		? `${post.url} (reply in https://x.com/i/status/${post.conversationId})`
		: post.url;
	lines.push(`${indent}${link}`);
	if (post.role === "requested") lines.push(`${indent}[the post you asked for]`);
	for (const line of post.text.split("\n")) lines.push(`${indent}${line}`);
	for (const m of post.media) {
		lines.push(`${indent}[${m.type}${m.durationMs ? ` ${Math.round(m.durationMs / 1000)}s` : ""}] ${m.url}`);
	}
	if (post.quoted) {
		lines.push(`${indent}> quoting ${postHeader(post.quoted)}`);
		lines.push(`${indent}> ${post.quoted.url}`);
		for (const line of post.quoted.text.split("\n")) lines.push(`${indent}> ${line}`);
	}
	for (const reply of post.replies) {
		lines.push("");
		lines.push(...postLines(reply, `${indent}  `));
	}
	return lines;
}

export function formatPosts(posts: XPost[]): string {
	return posts.map((p) => postLines(p, "").join("\n")).join("\n\n---\n\n");
}

export function formatUsers(users: XUser[]): string {
	return users
		.map((u) => {
			const who = u.username ? `@${u.username}${u.name ? ` (${u.name})` : ""}` : (u.name ?? `user ${u.id}`);
			const facts = [who, u.followers !== undefined && `${count(u.followers)} followers`, u.verified].filter(Boolean);
			return [facts.join(" · "), `${u.url} · id ${u.id}`, ...(u.bio ? [u.bio] : [])].join("\n");
		})
		.join("\n\n---\n\n");
}
