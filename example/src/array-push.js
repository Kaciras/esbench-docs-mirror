import { defineSuite } from "esbench";
import { randomNumbers } from "../utils/index.js";

export default defineSuite({
	name: "Push values to array",
	setup(scene) {
		const length = 1000;
		const data = randomNumbers(length);

		scene.bench("push each", () => {
			const copy = [];
			for (let i = 0; i < length; i++) {
				copy.push(data[i]);
			}
			return copy;
		});

		scene.bench("spread all", () => {
			const copy = [];
			copy.push(...data);
			return copy;
		});

		scene.bench("slice 1", () => {
			const copy = [];
			for (let i = 0; i < length; i += 1) {
				copy.push(...data.slice(i, i + 1));
			}
			return copy;
		});

		scene.bench("slice 10", () => {
			const copy = [];
			for (let i = 0; i < length; i += 10) {
				copy.push(...data.slice(i, i + 10));
			}
			return copy;
		});
	},
});