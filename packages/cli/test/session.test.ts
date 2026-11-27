import { describe, expect, it } from "vitest";
import { z } from "zod";
import { findOperation, type Operation } from "../src/registry.ts";
import { refusalOf } from "../src/session.ts";

const notFound = "Sorry, that page does not exist";

describe("refusalOf", () => {
	it("reads 404 code 34 on the settings endpoint as a refused request signature", () => {
		const refusal = refusalOf("account.settings", findOperation("account.settings")!, 404, [34], notFound);

		expect(refusal.toJSON()).toMatchObject({ type: "signature_rejected", status: 404, codes: [34] });
	});

	it("reads 404 code 34 on any other REST operation as X's own answer for a missing resource", () => {
		const lookup: Operation = {
			access: "read",
			args: z.object({}).strict(),
			request: { kind: "rest", method: "GET", path: "/1.1/statuses/show.json" },
			extract: (response) => response,
		};

		const refusal = refusalOf("status.show", lookup, 404, [34], notFound);

		expect(refusal.toJSON()).toMatchObject({ type: "x_error", status: 404, codes: [34] });
	});
});
