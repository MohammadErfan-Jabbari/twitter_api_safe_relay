// The animation sampler against what real Chromium reads from the same animations, recorded by
// test/support/record-chromium-animations.ts. The sampler runs as the page runs it, in a realm of its own whose
// getComputedStyle, like Moli's, ignores animations.
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { installAnimationSampling } from "../src/animations.ts";
import recorded from "./fixtures/chromium-animations.json" with { type: "json" };

type Recorded = (typeof recorded.cases)[number];

const sample = (c: Recorded) => {
	const page = vm.createContext({});
	vm.runInContext(
		`var Element = class { animate() { return { currentTime: ${c.time} }; } };
		var getComputedStyle = () => ({ color: "rgb(0, 0, 0)", transform: "none" });`,
		page,
	);
	vm.runInContext(`(${installAnimationSampling})()`, page);
	page.keyframes = c.keyframes;
	return vm.runInContext(
		`var div = new Element();
		div.animate(keyframes, ${c.duration});
		var style = getComputedStyle(div);
		({ color: style.color, transform: style.transform });`,
		page,
	) as { color: string; transform: string };
};

const numbers = (text: string) => (text.match(/-?[\d.]+(?:e-?\d+)?/g) ?? []).map(Number);

describe("the animation sampler", () => {
	it.each(recorded.cases.map((c, i) => [i, c] as const))("reads animation %i as Chromium does", (_, c) => {
		const sampled = sample(c);

		expect(sampled.color).toBe(c.chromium.color);
		// Chromium rounds the matrix to six significant digits from single-precision values, so the last digit may differ
		const matrix = numbers(sampled.transform);
		const expected = numbers(c.chromium.transform);
		expect(matrix).toHaveLength(expected.length);
		matrix.forEach((value, i) => {
			expect(value).toBeCloseTo(expected[i]!, 5);
		});
	});
});
