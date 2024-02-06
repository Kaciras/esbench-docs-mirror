import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { join, relative } from "path";
import { cwd, stdout } from "process";
import { performance } from "perf_hooks";
import chalk from "chalk";
import glob from "fast-glob";
import { durationFmt, MultiMap } from "@kaciras/utilities/node";
import { Builder, Executor, RunOptions } from "./toolchain.js";
import { ESBenchConfig, Nameable, normalizeConfig, NormalizedConfig, ToolchainOptions } from "./config.js";
import { ClientMessage, ESBenchResult } from "../index.js";
import { consoleLogHandler, resolveRE, SharedModeFilter } from "../utils.js";

interface Build {
	name: string;
	root: string;
	files: string[];
}

class JobGenerator {

	readonly nameMap = new Map<any, string | null>();
	readonly assetMap = new Map<Builder, Build>();
	readonly executorMap = new MultiMap<Executor, Builder>();
	readonly builderMap = new MultiMap<Builder, string>();

	private readonly directory: string;
	private readonly filter: FilterOptions;

	constructor(directory: string, filter: FilterOptions) {
		this.directory = directory;
		this.filter = filter;
	}

	add(toolchain: Required<ToolchainOptions>) {
		const { include, builders, executors } = toolchain;
		const builderRE = resolveRE(this.filter.builder);
		const executorRE = resolveRE(this.filter.executor);
		const workingDir = cwd();

		const ue = executors
			.filter(executor => executorRE.test(executor.name))
			.map(this.unwrapNameable.bind(this, "run"));

		// Ensure glob patterns is relative and starts with ./ or ../
		const dotGlobs = include.map(p => {
			p = relative(workingDir, p).replaceAll("\\", "/");
			return /\.\.?\//.test(p) ? p : "./" + p;
		});

		for (const builder of builders) {
			if (!builderRE.test(builder.name)) {
				continue;
			}
			const builderUsed = this.unwrapNameable("build", builder);
			this.builderMap.add(builderUsed, ...dotGlobs);
			this.executorMap.distribute(ue, builderUsed);
		}
	}

	async build(shared?: string) {
		const { directory, assetMap, nameMap } = this;
		let { file } = this.filter;

		if (file) {
			file = relative(cwd(), file).replaceAll("\\", "/");
		}

		const sharedFilter = SharedModeFilter.parse(shared);

		for (const [builder, include] of this.builderMap) {
			const name = nameMap.get(builder)!;
			let files = sharedFilter.select(await glob(include));
			if (file) {
				files = files.filter(p => p.includes(file!));
			}

			if (files.length === 0) {
				continue;
			}
			stdout.write(`Building suites with ${name}... `);

			const root = mkdtempSync(join(directory, "build-"));
			const start = performance.now();
			await builder.build(root, files);
			const time = performance.now() - start;

			console.log(chalk.greenBright(durationFmt.formatDiv(time, "ms")));
			assetMap.set(builder, { name, root, files });
		}
	}

	getJobs() {
		const jobs = new MultiMap<Executor, Build>();
		for (const [executor, builders] of this.executorMap) {
			for (const builder of builders) {
				const builds = this.assetMap.get(builder);
				if (builds) {
					jobs.add(executor, builds);
				}
			}
		}
		return jobs;
	}

	getName(tool: Builder | Executor) {
		const name = this.nameMap.get(tool);
		if (name) {
			return name;
		}
		throw new Error(`Tool ${tool.name} does not exists`);
	}

	private unwrapNameable(keyMethod: string, tool: Nameable<any>) {
		const { name } = tool;
		if (!name) {
			throw new Error("Tool name must be a non-empty string");
		}
		if (tool[keyMethod] === undefined) {
			tool = tool.use;
		}

		const existing = this.nameMap.get(tool);
		if (existing === undefined || existing === name) {
			this.nameMap.set(tool, name);
			return tool;
		}
		throw new Error("A tool can only have one name: " + name);
	}
}

interface FilterOptions {
	file?: string;
	builder?: string | RegExp;
	executor?: string | RegExp;
	name?: string | RegExp;
}

export class ESBenchHost {

	private readonly config: NormalizedConfig;

	readonly result: ESBenchResult = {};

	constructor(config: ESBenchConfig) {
		this.config = normalizeConfig(config);
	}

	private onMessage(executor: string, builder: string, message: ClientMessage) {
		if ("level" in message) {
			consoleLogHandler(message.level, message.log);
		} else {
			const { name } = message;
			(this.result[name] ??= []).push({ executor, builder, ...message });
		}
	}

	async run(filter: FilterOptions = {}, shared?: string) {
		const { reporters, toolchains, tempDir, diff, cleanTempDir } = this.config;
		const startTime = performance.now();

		mkdirSync(tempDir, { recursive: true });

		const generator = new JobGenerator(tempDir, filter);
		for (const toolchain of toolchains) {
			generator.add(toolchain);
		}
		await generator.build(shared);
		const jobs = generator.getJobs();

		if (jobs.size === 0) {
			throw new Error("\nNo file matching the include pattern of toolchains");
		}

		const context: Partial<RunOptions> = {
			tempDir,
			pattern: resolveRE(filter.name).source,
		};

		for (const [executor, builds] of jobs) {
			const eName = generator.getName(executor);

			await executor.start?.();
			console.log(`Running suites with: ${eName}.`);

			for (const { name, root, files } of builds) {
				context.handleMessage = this.onMessage.bind(this, eName, name);
				context.files = files;
				context.root = root;
				await executor.run(context as RunOptions);
			}
			await executor.close?.();
		}

		console.log(); // Add an empty line between running & reporting phase.

		const previous = diff && loadJSON(diff, false);
		for (const reporter of reporters) {
			await reporter(this.result, previous);
		}

		/*
		 * We did not put the cleanup code to finally block,
		 * so that you can check the build output when error occurred.
		 */
		if (cleanTempDir) {
			try {
				rmSync(tempDir, { recursive: true });
			} catch (e) {
				console.error(e); // It's ok to keep running.
			}
		}

		const timeUsage = performance.now() - startTime;
		console.log(`Global total time: ${durationFmt.formatMod(timeUsage, "ms")}.`);
	}
}

function loadJSON(path: string, throwIfMissing: boolean) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (e) {
		if (throwIfMissing || e.code !== "ENOENT") throw e;
	}
}

export async function report(config: ESBenchConfig, files: string[]) {
	const { reporters, diff } = normalizeConfig(config);

	const result = loadJSON(files[0], true) as ESBenchResult;

	for (let i = 1; i < files.length; i++) {
		const more = loadJSON(files[i], true) as ESBenchResult;
		for (const [name, suite] of Object.entries(more)) {
			(result[name] ??= []).push(...suite);
		}
	}

	const previous = diff && loadJSON(diff, false);
	for (const reporter of reporters) {
		await reporter(result, previous);
	}
}
