// What x-cli reads from X's page: the GraphQL operation definitions in its webpack modules, and which kind of
// page the browser is on.

export type OperationDefinition = {
	queryId: string;
	operationName: string;
	operationType: "query" | "mutation";
	metadata: { featureSwitches: string[]; fieldToggles: string[] };
};

// Runs inside the page, so it must not reference anything outside itself. Each operation is a module whose
// source reads e.exports={queryId:"…",operationName:"…",operationType:"…",metadata:{featureSwitches:[…],
// fieldToggles:[…]}}. The bridge wraps every module it sees and keeps the original as elonmusk_114514_original;
// modules loaded after the bridge found X's client are not wrapped.
export const readOperationsInPage = (): OperationDefinition[] => {
	const chunks = (globalThis as any).webpackChunk_twitter_responsive_web;
	if (!Array.isArray(chunks)) {
		return [];
	}
	const pattern =
		/queryId:"([^"]+)",operationName:"([^"]+)",operationType:"(query|mutation)",metadata:\{featureSwitches:\[([^\]]*)\],fieldToggles:\[([^\]]*)\]\}/g;
	const strings = (list: string) => Array.from(list.matchAll(/"([^"]*)"/g), (match) => match[1] as string);
	const found: Record<string, OperationDefinition> = {};
	for (const chunk of chunks) {
		const modules = Array.isArray(chunk) ? chunk[1] : undefined;
		if (!modules || typeof modules !== "object") {
			continue;
		}
		for (const key of Object.keys(modules)) {
			const factory = modules[key];
			const original = factory?.elonmusk_114514_original ?? factory;
			if (typeof original !== "function") {
				continue;
			}
			const source = Function.prototype.toString.call(original);
			if (!source.includes("operationName:")) {
				continue;
			}
			for (const match of source.matchAll(pattern)) {
				const [, queryId, operationName, operationType, featureSwitches, fieldToggles] = match as unknown as string[];
				found[operationName as string] = {
					queryId: queryId as string,
					operationName: operationName as string,
					operationType: operationType as "query" | "mutation",
					metadata: { featureSwitches: strings(featureSwitches ?? ""), fieldToggles: strings(fieldToggles ?? "") },
				};
			}
		}
	}
	return Object.values(found);
};

export type PageState = "app" | "logged_out" | "challenge";

// X sends a signed-out browser to a login or onboarding page, and a flagged account to an access or lock page.
export const pageStateOf = (url: string): PageState => {
	let pathname: string;
	try {
		pathname = new URL(url).pathname;
	} catch {
		return "app";
	}
	if (
		/^\/(account\/(access|locked|suspended)|i\/flow\/(consent_flow|login_challenge)|i\/flow\/.*challenge)/.test(
			pathname,
		)
	) {
		return "challenge";
	}
	if (pathname === "/" || /^\/(login|logout|i\/flow\/(login|signup)|i\/jf\/onboarding)/.test(pathname)) {
		return "logged_out";
	}
	return "app";
};
