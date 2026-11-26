// Turns X's GraphQL responses into small JSON records. X moves fields between releases (screen_name moved from
// legacy to core in 2025), so each reader tries the known places and the timeline reader finds the
// instructions array wherever the operation nests it.

type Json = any;

export type Page<T> = { items: T[]; cursor: string | undefined };

export const findInstructions = (value: Json, depth = 0): Json[] | undefined => {
	if (value === null || typeof value !== "object" || depth > 8) {
		return undefined;
	}
	if (Array.isArray(value.instructions)) {
		return value.instructions;
	}
	for (const child of Object.values(value)) {
		const found = findInstructions(child, depth + 1);
		if (found) {
			return found;
		}
	}
	return undefined;
};

// Every itemContent in the timeline (single items and the items of modules), plus the bottom cursor
const timelineItems = (response: Json) => {
	const instructions = findInstructions(response?.data) ?? [];
	const contents: Json[] = [];
	let cursor: string | undefined;
	const visitEntry = (entry: Json) => {
		const content = entry?.content ?? entry?.item;
		if (!content) {
			return;
		}
		if (content.cursorType === "Bottom" || content.itemContent?.cursorType === "Bottom") {
			cursor = content.value ?? content.itemContent?.value;
		}
		if (content.itemContent) {
			contents.push(content.itemContent);
		}
		for (const item of content.items ?? []) {
			if (item?.item?.itemContent) {
				contents.push(item.item.itemContent);
			}
		}
	};
	for (const instruction of instructions) {
		for (const entry of instruction.entries ?? []) {
			visitEntry(entry);
		}
		if (instruction.entry) {
			visitEntry(instruction.entry);
		}
	}
	return { contents, cursor };
};

export const user = (result: Json) => {
	if (!result || result.__typename === "UserUnavailable") {
		return undefined;
	}
	return {
		id: result.rest_id as string,
		screenName: (result.core?.screen_name ?? result.legacy?.screen_name) as string,
		name: (result.core?.name ?? result.legacy?.name) as string,
		protected: Boolean(result.privacy?.protected ?? result.legacy?.protected),
	};
};

export type Tweet = {
	id: string;
	author: { screenName: string; name: string } | undefined;
	text: string;
	createdAt: string | undefined;
	url: string;
	retweetOf?: Tweet;
	quoted?: Tweet;
};

export const tweet = (result: Json): Tweet | undefined => {
	const t = result?.__typename === "TweetWithVisibilityResults" ? result.tweet : result;
	if (!t?.rest_id) {
		return undefined;
	}
	const author = user(t.core?.user_results?.result);
	const retweeted = t.legacy?.retweeted_status_result?.result;
	const quoted = t.quoted_status_result?.result;
	return {
		id: t.rest_id,
		author: author && { screenName: author.screenName, name: author.name },
		text: t.note_tweet?.note_tweet_results?.result?.text ?? t.legacy?.full_text ?? "",
		createdAt: t.legacy?.created_at,
		url: `https://x.com/${author?.screenName ?? "i"}/status/${t.rest_id}`,
		...(retweeted ? { retweetOf: tweet(retweeted) } : {}),
		...(quoted ? { quoted: tweet(quoted) } : {}),
	};
};

export const list = (value: Json) => {
	if (!value?.id_str) {
		return undefined;
	}
	return {
		id: value.id_str as string,
		name: value.name as string,
		description: (value.description ?? "") as string,
		private: value.mode === "Private",
		memberCount: value.member_count as number | undefined,
		subscriberCount: value.subscriber_count as number | undefined,
		owner: user(value.user_results?.result)?.screenName,
	};
};

const compact = <T>(values: (T | undefined)[]) => values.filter((value): value is T => value !== undefined);

export const tweetPage = (response: Json): Page<Tweet> => {
	const { contents, cursor } = timelineItems(response);
	return { items: compact(contents.map((c) => tweet(c.tweet_results?.result))), cursor };
};

export const userPage = (response: Json): Page<NonNullable<ReturnType<typeof user>>> => {
	const { contents, cursor } = timelineItems(response);
	return { items: compact(contents.map((c) => user(c.user_results?.result))), cursor };
};

export const listPage = (response: Json): Page<NonNullable<ReturnType<typeof list>>> => {
	const { contents, cursor } = timelineItems(response);
	const seen = new Set<string>();
	const items = compact(contents.map((c) => list(c.list))).filter((l) => !seen.has(l.id) && seen.add(l.id));
	return { items, cursor };
};

export const folderPage = (response: Json): Page<{ id: string; name: string }> => {
	const slice = response?.data?.viewer?.user_results?.result?.bookmark_collections_slice;
	const items = (slice?.items ?? []).map((item: Json) => ({ id: String(item.id), name: String(item.name) }));
	return { items, cursor: slice?.slice_info?.next_cursor };
};
