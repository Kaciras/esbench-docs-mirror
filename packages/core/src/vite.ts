import { build, InlineConfig, mergeConfig, Plugin } from "vite";
import { TransformContext, Transformer } from "./transform.js";

const ENTRY_ID = "./ESBench_Main.js";

const mainCode = `
import runSuites from "@esbench/core/src/worker.js";

const modules = {__IMPORTS__\n};

function dynamicImport(file) {
	return suites[file]();
}

export default function (channel, files, name) {
	return runSuites(channel, dynamicImport, files, name);
}`;

function createEntry(files: string[]) {
	let imports = "";
	for (const file of files) {
		imports += `\n\t"${file}": () => import("${file}"),`;
	}
	return mainCode.replace("__IMPORTS__", imports);
}

function vitePlugin(files: string[]): Plugin {
	return {
		name: "ESBench-entry",
		resolveId(id) {
			if (id === ENTRY_ID) {
				return ENTRY_ID;
			}
		},
		load(id) {
			if (id === ENTRY_ID) {
				return createEntry(files);
			}
		},
	};
}

const defaults: InlineConfig = {
	build: {
		target: "esnext",
		minify: false,
		modulePreload: false,
		rollupOptions: {
			preserveEntrySignatures: "strict",
			input: ENTRY_ID,
			output: {
				entryFileNames: "[name].js",
			},
		},
	},
};

export default class ViteProcessor implements Transformer {

	private readonly config: InlineConfig;

	readonly name: string;

	constructor(config: InlineConfig) {
		this.name = "Vite";
		this.config = mergeConfig(defaults, config);
	}

	transform(ctx: TransformContext) {
		const config = mergeConfig(this.config, {
			build: {
				outDir: ctx.root,
			},
			plugins: [
				vitePlugin(ctx.files),
			],
		});
		return build(config).then(() => ENTRY_ID);
	}
}
