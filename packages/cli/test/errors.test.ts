import { describe, expect, it } from "vitest";
import { isErrorType } from "../src/errors.ts";

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
