import { Awaitable, CartesianObjectCell, CPSrcObject } from "@kaciras/utilities/browser";
import { RE_ANY, runFns } from "./utils.js";
import { Profiler } from "./profiling.js";
import { TimeProfilerOptions } from "./time.js";
import { ValidateOptions } from "./validate.js";

export type HookFn = () => Awaitable<unknown>;

type Workload = () => Awaitable<unknown>;

export class BenchCase {

	readonly beforeHooks: HookFn[];
	readonly afterHooks: HookFn[];

	readonly name: string;

	/**
	 * The workload function, should be called with iteration hooks.
	 */
	readonly fn: Workload;

	/**
	 * true if the case defined by `benchAsync`, false for `bench`.
	 */
	readonly isAsync: boolean;

	/**
	 * A unique number within a suite execution.
	 */
	id!: number;

	constructor(scene: Scene, name: string, fn: Workload, isAsync: boolean) {
		this.name = name;
		this.fn = fn;
		this.isAsync = isAsync;
		this.beforeHooks = scene.beforeIterHooks;
		this.afterHooks = scene.afterIterHooks;
	}

	/**
	 * Call the workload and each iteration hook once.
	 */
	async invoke(): Promise<any> {
		await runFns(this.beforeHooks);
		try {
			return await this.fn();
		} finally {
			await runFns(this.afterHooks);
		}
	}
}

export class Scene<P = any> {

	readonly teardownHooks: HookFn[] = [];
	readonly beforeIterHooks: HookFn[] = [];
	readonly afterIterHooks: HookFn[] = [];
	readonly cases: BenchCase[] = [];

	readonly params: P;

	private readonly include: RegExp;

	constructor(params: P, include = RE_ANY) {
		this.params = params;
		this.include = include;
	}

	/**
	 * Register a callback to be called exactly once before each benchmark invocation.
	 * It's not recommended to use this in microbenchmarks because it can spoil the results.
	 */
	beforeIteration(fn: HookFn) {
		this.beforeIterHooks.push(fn);
	}

	/**
	 * Register a callback to be called exactly once after each invocation.
	 * It's not recommended to use this in microbenchmarks because it can spoil the results.
	 */
	afterIteration(fn: HookFn) {
		this.afterIterHooks.push(fn);
	}

	/**
	 * Teardown function to run after all case in the scene are executed.
	 */
	teardown(fn: HookFn) {
		this.teardownHooks.push(fn);
	}

	bench(name: string, fn: Workload) {
		this.add(name, fn, false);
	}

	benchAsync(name: string, fn: Workload) {
		this.add(name, fn, true);
	}

	/*
	 * Don't use `isAsync = fn.constructor !== Function` because the fn can be
	 * non-async and return a Promise.
	 *
	 * For example:
	 * scene.bench("name", () => asyncFn(args));
	 *
	 * It can be fixed by adding `await` to the function, but it impacts performance.
	 * Related benchmark: example/es/async-return-promise.js
	 */
	private add(name: string, fn: Workload, isAsync: boolean) {
		if (/^\s*$/.test(name)) {
			throw new Error("Case name cannot be blank.");
		}
		if (this.cases.some(c => c.name === name)) {
			throw new Error(`Case "${name}" already exists.`);
		}
		if (this.include.test(name)) {
			this.cases.push(new BenchCase(this, name, fn, isAsync));
		}
	}
}

export type BaselineOptions = {
	/**
	 * Type of the baseline variable, can be one of:
	 * - "Name", "Builder", "Executor"
	 * - Any key of suite's `params` object.
	 */
	type: string;

	/**
	 * Case with variable value equals to this is the baseline.
	 */
	value: unknown;
}

type Empty = Record<string, undefined[]>;
type ParamsAny = Record<string, any[]>;

export interface BenchmarkSuite<T extends CPSrcObject = ParamsAny> {
	/**
	 * Setup each scene, add your benchmark cases.
	 */
	setup: (scene: Scene<CartesianObjectCell<T>>) => Awaitable<void>;

	/**
	 * Runs a function before running the suite.
	 */
	beforeAll?: HookFn;

	/**
	 * Runs a function after the suite has finished running.
	 */
	afterAll?: HookFn;

	/**
	 * Add more profilers for the suite, falsy values are ignored.
	 */
	profilers?: Array<Profiler | false | undefined>;

	/**
	 * Measure the running time of the benchmark function.
	 * true is equivalent to not specifying the option and will always choose the default value.
	 *
	 * @default true
	 */
	timing?: boolean | TimeProfilerOptions;

	/**
	 * Checks if it is possible to run your benchmarks.
	 * If set, all scenes and their cases will be run once to ensure no exceptions.
	 *
	 * Additional checks can be configured in the options.
	 */
	validate?: ValidateOptions<CartesianObjectCell<T>>;

	/**
	 * you can specify set of values. As a result, you will get results for each combination of params values.
	 * If not specified, or it is an empty object, the suite will have one scene with empty params.
	 *
	 * The keys for the suite parameters must be the same under all toolchains.
	 */
	params?: T;

	/**
	 * In order to scale your results, you can mark a variable as a baseline.
	 *
	 * @example
	 * // The result with baseline: { type: "Name", value: "map" }
	 * | No. |         Name |      time | time.ratio |
	 * | --: | -----------: | --------: | ---------: |
	 * |   0 |    For-index |  11.39 us |      1.00x |
	 * |   1 |       For-of |  27.36 us |      2.40x |
	 * |   2 | Array.reduce |   1.99 us |      0.17x |
	 */
	baseline?: BaselineOptions;
}

export type UserSuite<T extends CPSrcObject = ParamsAny> = BenchmarkSuite<T> | BenchmarkSuite<Empty>["setup"];

/**
 * Type helper to mark the object as an ESBench suite. IDE plugins require it to find benchmark cases.
 */
export function defineSuite<const T extends CPSrcObject = Empty>(suite: UserSuite<T>) {
	return suite;
}
