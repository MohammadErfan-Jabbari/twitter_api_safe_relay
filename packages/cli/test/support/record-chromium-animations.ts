// Records what real Chromium's getComputedStyle reads from animations of the shape X's ondemand.s module samples, to
// test/fixtures/chromium-animations.json. The sampler test checks src/animations.ts against these readings, and the
// mock page signs with one of them. Rerun after a Chromium update:
//   npx playwright install chromium && node test/support/record-chromium-animations.ts
import fs from "node:fs";
import { chromium } from "playwright";

type Case = {
	keyframes: { color: [string, string]; transform: [string, string]; easing: string };
	duration: number;
	time: number;
};

// A seeded generator, so a rerun records the same animations
let seed = 20261127;
const random = () => {
	seed = (seed * 1103515245 + 12345) % 2147483648;
	return seed / 2147483648;
};
const hex = () =>
	`#${Array.from({ length: 3 }, () =>
		Math.floor(random() * 256)
			.toString(16)
			.padStart(2, "0"),
	).join("")}`;
const twoPlaces = (value: number) => Math.round(value * 100) / 100;

const animation = (
	from: string,
	to: string,
	degrees: number,
	curve: number[],
	time: number,
	duration = 4096,
): Case => ({
	keyframes: {
		color: [from, to],
		transform: ["rotate(0deg)", `rotate(${degrees}deg)`],
		easing: `cubic-bezier(${curve.join(",")})`,
	},
	duration,
	time,
});

const cases: Case[] = [
	// The animation the mock page signs with (values seen on x.com on 2026-11-27)
	animation("#2a03e0", "#e20f59", 167, [0.71, 0.51, 0.38, -0.8], 1500),
	// The ends of the active interval
	...[0, 1, 2048, 4095, 4095.9].map((time) => animation("#000000", "#ffffff", 360, [0.25, 0.1, 0.25, 1], time)),
	// A curve whose y runs past [0, 1], so the color clamps
	animation("#10f0f0", "#f01010", 90, [0.5, -1, 0.5, 2], 1000),
	animation("#10f0f0", "#f01010", 90, [0.5, -1, 0.5, 2], 3000),
	// Other durations
	animation("#336699", "#996633", 45, [0.42, 0, 0.58, 1], 333, 1000),
	animation("#336699", "#996633", 270, [0, 0, 1, 1], 7777, 8192),
];
while (cases.length < 64) {
	const duration = 4096;
	cases.push(
		animation(
			hex(),
			hex(),
			Math.floor(random() * 361),
			[twoPlaces(random()), twoPlaces(random() * 2 - 1), twoPlaces(random()), twoPlaces(random() * 2 - 1)],
			Math.floor(random() * duration),
			duration,
		),
	);
}

const browser = await chromium.launch();
try {
	const page = await browser.newPage();
	await page.setContent("<!doctype html><html><body></body></html>");
	const readings = await page.evaluate((all) => {
		// This package compiles without the DOM types
		const window = globalThis as any;
		return all.map((c) => {
			const div = window.document.createElement("div");
			window.document.body.appendChild(div);
			const running = div.animate(c.keyframes, c.duration);
			running.pause();
			running.currentTime = c.time;
			const style = window.getComputedStyle(div);
			const reading: { color: string; transform: string } = { color: style.color, transform: style.transform };
			div.remove();
			return reading;
		});
	}, cases);
	const recorded = {
		chromium: browser.version(),
		recordedOn: new Date().toISOString().slice(0, 10),
		cases: cases.map((c, i) => ({ ...c, chromium: readings[i] })),
	};
	const out = new URL("../fixtures/chromium-animations.json", import.meta.url);
	fs.writeFileSync(out, `${JSON.stringify(recorded, null, "\t")}\n`);
	console.log(`${cases.length} animations recorded from Chromium ${recorded.chromium}`);
} finally {
	await browser.close();
}
