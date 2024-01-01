import { defineConfig, PlaywrightExecutor, rawReporter, textReporter, ViteBuilder } from "@esbench/core";
import { chromium, firefox, webkit } from "playwright-core";

export default defineConfig({
	reporters: [
		rawReporter(),
		textReporter({ stdDev: true }),
	],
	stages: [{
		include: ["./src/*.js"],
		builders: [
			new ViteBuilder(),
		// 	new RollupBuilder(),
		],
		executors: [
			new PlaywrightExecutor(firefox),
			new PlaywrightExecutor(chromium),
			new PlaywrightExecutor(webkit),
			// new DirectExecutor(),
			// new NodeExecutor(),
			// new ProcessExecutor("node"),
		],
	}],
});
