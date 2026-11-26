import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		testTimeout: 120_000,
		hookTimeout: 60_000,
		// The end-to-end suite owns fixed ports and one browser, so files run one at a time.
		fileParallelism: false,
	},
});
