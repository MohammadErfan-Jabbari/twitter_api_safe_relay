// Moli applies no animation effects to computed style: a paused animation reads back as the element's base color
// and no transform. X's page signs each API request with an x-client-transaction-id derived from such a sample (its
// ondemand.s module animates a div's color and rotation, pauses it at a time picked from the page's key, and reads
// getComputedStyle), so under Moli every id is wrong, and X answers 404 code 34 to the endpoints that check it,
// account/settings.json among them. This samples the one shape X uses, two color and rotate() keyframes with a
// cubic-bezier easing, the way Chrome does. A browser that samples animations itself is left alone.
//
// Runs inside the page before X's scripts, so it must not reference anything outside itself.
export const installAnimationSampling = () => {
	// The page's DOM, reached through globalThis because this package compiles without the DOM types
	const scope = globalThis as any;
	const element = scope.Element;
	if (scope.__xCliAnimationSampling || !element?.prototype?.animate) {
		return;
	}
	scope.__xCliAnimationSampling = true;

	type Sampler = (time: number) => { color: string; transform: string } | undefined;

	const colorOf = (value: unknown): number[] | undefined => {
		const text = String(value).trim();
		const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
		if (hex) {
			const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
			return [0, 2, 4].map((at) => Number.parseInt(full.slice(at, at + 2), 16));
		}
		const rgb = text.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
		return rgb ? rgb.slice(1, 4).map(Number) : undefined;
	};

	const degreesOf = (value: unknown) => {
		const match = String(value)
			.trim()
			.match(/^rotate\(\s*(-?[\d.]+)deg\s*\)$/);
		return match ? Number(match[1]) : undefined;
	};

	const easingOf = (value: unknown): ((x: number) => number) | undefined => {
		if (value === undefined || value === "linear") {
			return (x) => x;
		}
		const match = String(value).match(
			/^cubic-bezier\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)$/,
		);
		if (!match) {
			return undefined;
		}
		const [x1, y1, x2, y2] = match.slice(1).map(Number) as [number, number, number, number];
		const curve = (a: number, b: number, t: number) => 3 * a * (1 - t) ** 2 * t + 3 * b * (1 - t) * t ** 2 + t ** 3;
		return (x) => {
			// x1 and x2 lie in [0, 1], so the x curve rises monotonically and bisection finds t
			let low = 0;
			let high = 1;
			let t = x;
			for (let step = 0; step < 64; step++) {
				const estimate = curve(x1, x2, t);
				if (Math.abs(estimate - x) < 1e-9) {
					break;
				}
				if (estimate < x) {
					low = t;
				} else {
					high = t;
				}
				t = (low + high) / 2;
			}
			return curve(y1, y2, t);
		};
	};

	// Chrome prints at most six significant digits
	const number = (value: number) => String(Number(value.toPrecision(6)));

	const samplerOf = (keyframes: any, options: any): Sampler | undefined => {
		const duration = typeof options === "number" ? options : undefined;
		if (!keyframes || Array.isArray(keyframes) || !duration || duration <= 0) {
			return undefined;
		}
		const names = Object.keys(keyframes)
			.filter((name) => name !== "easing")
			.sort()
			.join(",");
		if (names !== "color,transform" || keyframes.color?.length !== 2 || keyframes.transform?.length !== 2) {
			return undefined;
		}
		const from = colorOf(keyframes.color[0]);
		const to = colorOf(keyframes.color[1]);
		const startAngle = degreesOf(keyframes.transform[0]);
		const endAngle = degreesOf(keyframes.transform[1]);
		const ease = easingOf(keyframes.easing);
		if (!from || !to || startAngle === undefined || endAngle === undefined || !ease) {
			return undefined;
		}
		return (time) => {
			const progress = time / duration;
			// Outside its active interval an animation without fill has no effect
			if (!(progress >= 0 && progress < 1)) {
				return undefined;
			}
			const eased = ease(progress);
			const channel = (index: number) =>
				Math.round(Math.min(255, Math.max(0, from[index]! + (to[index]! - from[index]!) * eased)));
			const radians = ((startAngle + (endAngle - startAngle) * eased) * Math.PI) / 180;
			const cos = Math.cos(radians);
			const sin = Math.sin(radians);
			return {
				color: `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`,
				transform: `matrix(${number(cos)}, ${number(sin)}, ${number(-sin)}, ${number(cos)}, 0, 0)`,
			};
		};
	};

	// The replacements are proxies of the natives, so their name, length, own properties and descriptors stay the
	// natives' own, and Function.prototype.toString prints each as the native it replaces, as stealth patches do.
	// A page that checks them, as X's scripts may, sees the browser's functions.
	const disguised = new WeakMap<object, object>();
	const replace = (holder: any, key: string, apply: (native: any, self: any, args: any[]) => unknown) => {
		const native = holder[key];
		const replacement = new Proxy(native, { apply: (target, self, args) => apply(target, self, args) });
		disguised.set(replacement, native);
		holder[key] = replacement;
	};
	replace(scope.Function.prototype, "toString", (native, self, args) =>
		Reflect.apply(native, disguised.get(self) ?? self, args),
	);

	const animated = new WeakMap<object, { animation: any; sample: Sampler }>();
	replace(element.prototype, "animate", (native, self, args) => {
		const animation = Reflect.apply(native, self, args);
		const sample = samplerOf(args[0], args[1]);
		if (sample) {
			animated.set(self, { animation, sample });
		}
		return animation;
	});

	replace(scope, "getComputedStyle", (native, self, args) => {
		const style: any = Reflect.apply(native, self, args);
		const [target, pseudo] = args;
		const entry = pseudo ? undefined : animated.get(target);
		const time = entry?.animation.currentTime;
		// A browser that samples animations itself already shows the rotation
		if (!entry || typeof time !== "number" || style.transform !== "none") {
			return style;
		}
		const sampled: Record<string, string> | undefined = entry.sample(time);
		if (!sampled) {
			return style;
		}
		return new Proxy(style, {
			get: (declaration, key) => {
				if (typeof key === "string" && Object.hasOwn(sampled, key)) {
					return sampled[key];
				}
				if (key === "getPropertyValue") {
					return (name: string) => (Object.hasOwn(sampled, name) ? sampled[name] : declaration.getPropertyValue(name));
				}
				const value = Reflect.get(declaration, key, declaration);
				return typeof value === "function" ? value.bind(declaration) : value;
			},
		});
	});
};
