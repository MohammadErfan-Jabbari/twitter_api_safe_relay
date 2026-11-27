import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { errorTypes, isErrorType } from "../src/errors.ts";

describe("isErrorType", () => {
	it("accepts the listed types and nothing an object inherits", () => {
		expect(["timeout", "wrong_account", "internal"].map(isErrorType)).toEqual([true, true, true]);
		expect(["constructor", "toString", "__proto__", "hasOwnProperty"].map(isErrorType)).toEqual([
			false,
			false,
			false,
			false,
		]);
	});
});

describe("the README's error table", () => {
	it("lists every error type with its exit code", () => {
		const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
		const rows = Array.from(readme.matchAll(/^\| `([a-z_]+)` \| (\d+) \|/gm), (match) => [match[1], Number(match[2])]);

		expect(Object.fromEntries(rows)).toEqual(errorTypes);
	});
});
