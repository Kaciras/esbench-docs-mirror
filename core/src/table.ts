import type { ForegroundColorName } from "chalk";
import { mean, quantileSorted, standardDeviation } from "simple-statistics";
import {
	dataSizeIEC,
	decimalPrefix,
	durationFmt,
	identity,
	separateThousand,
	UnitConvertor,
} from "@kaciras/utilities/browser";
import { markdownTable } from "markdown-table";
import { TukeyOutlierDetector } from "./math.js";
import { MetricAnalysis, MetricMeta, Metrics } from "./profiling.js";
import { BUILTIN_VARS } from "./utils.js";
import { ToolchainResult } from "./connect.js";
import { ResultBaseline } from "./runner.js";
import { FlattedResult, Summary } from "./summary.js";

type RatioStyle = "value" | "percentage" | "trend";
type Outliers = "worst" | "best" | "all";

export interface SummaryTableOptions {
	/**
	 * Show standard deviation (*.SD) columns in the table.
	 *
	 * @default true
	 *
	 * @example
	 * textReporter({ stdDev: true })
	 * | No. |      Name |    time | time.SD |
	 * | --: | --------: | ------: | ------: |
	 * |   0 | For-index | 0.37 ns | 0.01 ns |
	 * |   1 |    For-of | 6.26 ns | 2.88 ns |
	 */
	stdDev?: boolean;

	/**
	 * By default, variables with only one value are omitted from the table.
	 * Set to true to show all variables.
	 *
	 * @default false
	 */
	showSingle?: boolean;

	/**
	 * Show percentile columns in the table.
	 *
	 * @example
	 * textReporter({ percentiles: [75, 99] })
	 * | No. |   name |      time |  time.p75 | time.p99 |
	 * | --: | -----: | --------: | --------: | -------: |
	 * |   0 | object | 938.45 ms | 992.03 ms |   1.08 s |
	 * |   1 |    map |    1.03 s |    1.07 s |    1.1 s |
	 */
	percentiles?: number[];

	/**
	 * Specifies which outliers should be removed from the distribution.
	 *
	 * @default "all"
	 */
	outliers?: false | Outliers;

	/**
	 * Using ratioStyle, we can override the style of the diff and the baseline column.
	 *
	 * @example
	 *            "percentage"      "trend"       "value"
	 *    time   | time.ratio | | time.ratio | | time.ratio |
	 * 117.26 us |      0.00% | |    100.00% | |      1.00x | (baseline)
	 * 274.14 us |   +133.79% | |    233.79% | |      2.34x |
	 *  19.82 us |    -83.10% | |     16.90% | |      0.17x |
	 *
	 * @default "percentage“
	 */
	ratioStyle?: RatioStyle;
}

type ANSIColor = Exclude<ForegroundColorName, "gray" | "grey">
type Stainer = Record<ANSIColor, (str: string) => string> & {
	(str: string): string;
};

const noColors = new Proxy(identity as Stainer, { get: identity });
const kRowNumber = Symbol();
const kProcessedMetrics = Symbol();

function getMetrics(item: FlattedResult) {
	return item[kProcessedMetrics] as Metrics;
}

function styleRatio(v: number, style: RatioStyle, meta: MetricMeta): ColoredValue {
	if (!Number.isFinite(v)) {
		return ["N/A", "blackBright"];
	}
	const color: ANSIColor | null = v === 1
		? null : (v < 1 === meta.lowerIsBetter)
			? "green" : "red";

	switch (style) {
		case "trend":
			return [`${(v * 100).toFixed(2)}%`, color];
		case "value":
			return [`${v.toFixed(2)}x`, color];
		case "percentage":
			v = (v - 1) * 100;
			return [v > 0 ? `+${v.toFixed(2)}%` : `${v.toFixed(2)}%`, color];
	}
}

type CellValue = string | number | undefined;
type CellColor = ANSIColor | null;
type ColoredValue = CellValue | [CellValue, ANSIColor | null];

interface ColumnFactory {

	name: ColoredValue;

	format?: string;

	prepare?(cases: FlattedResult[]): void;

	getValue(data: FlattedResult): ColoredValue | undefined;
}

class RowNumberColumn implements ColumnFactory {

	readonly name = "No.";

	private index = 0;

	getValue(data: FlattedResult) {
		data[kRowNumber] = this.index;
		return (this.index++).toString();
	}
}

class VariableColumn implements ColumnFactory {

	readonly name: ColoredValue;

	private readonly key: string;

	constructor(key: string) {
		this.name = this.key = key;
		if (!BUILTIN_VARS.includes(this.key)) {
			this.name = [this.name, "magentaBright"];
		}
	}

	getValue(data: FlattedResult) {
		return data[this.key];
	}
}

class RawMetricColumn implements ColumnFactory {

	readonly meta: MetricMeta;
	readonly name: string;

	constructor(meta: MetricMeta) {
		this.meta = meta;
		this.name = meta.key;
	}

	get format() {
		return this.meta.format;
	}

	getValue(data: FlattedResult) {
		const metric = getMetrics(data)[this.name];
		return Array.isArray(metric) ? mean(metric) : metric;
	}
}

abstract class StatisticsColumn implements ColumnFactory {

	protected readonly meta: MetricMeta;

	abstract readonly name: string;

	constructor(meta: MetricMeta) {
		this.meta = meta;
	}

	get format() {
		return this.meta.format;
	}

	abstract calculate(values: number[]): number;

	getValue(data: FlattedResult) {
		const { key } = this.meta;
		const values = getMetrics(data)[key];
		if (Array.isArray(values)) {
			return this.calculate(values);
		}
		if (values !== undefined) {
			throw new TypeError(`Metric "${key}" must be an array`);
		}
	}
}

class StdDevColumn extends StatisticsColumn {

	get name() {
		return this.meta.key + ".SD";
	}

	calculate(values: number[]) {
		return standardDeviation(values);
	}
}

class PercentileColumn extends StatisticsColumn {

	private readonly p: number;

	constructor(meta: MetricMeta, p: number) {
		super(meta);
		this.p = p;
	}

	get name() {
		return `${this.meta.key}.p${this.p}`;
	}

	calculate(values: number[]) {
		return quantileSorted(values, this.p / 100);
	}
}

class BaselineColumn implements ColumnFactory {

	private readonly meta: MetricMeta;
	private readonly variable: string;
	private readonly value: string;
	private readonly style: RatioStyle;

	private ratio1 = 0;

	constructor(meta: MetricMeta, baseline: ResultBaseline, style: RatioStyle) {
		this.meta = meta;
		this.variable = baseline.type;
		this.value = baseline.value;
		this.style = style;
	}

	get name() {
		return this.meta.key + ".ratio";
	}

	private toNumber(data: FlattedResult) {
		const metric = getMetrics(data)[this.meta.key];
		if (Array.isArray(metric)) {
			return mean(metric);
		}
		return typeof metric === "number" ? metric : 0;
	}

	prepare(cases: Iterable<FlattedResult>) {
		const { variable, value } = this;
		for (const row of cases) {
			if (row[variable] === value) {
				return this.ratio1 = this.toNumber(row);
			}
		}
	}

	getValue(data: FlattedResult) {
		const { ratio1, meta } = this;

		const ratio = this.toNumber(data) / ratio1;
		return styleRatio(ratio, this.style, meta);
	}
}

class DifferenceColumn implements ColumnFactory {

	private readonly another: Summary;
	private readonly meta: MetricMeta;
	private readonly style: RatioStyle;

	constructor(another: Summary, meta: MetricMeta, style: RatioStyle) {
		this.another = another;
		this.meta = meta;
		this.style = style;
	}

	get name() {
		return `${this.meta.key}.diff`;
	}

	private toNumber(data: Metrics): number | undefined {
		const metric = data[this.meta.key];
		return Array.isArray(metric) ? mean(metric) : metric as number;
	}

	getValue(data: FlattedResult) {
		const previous = this.another.find(data);
		if (!previous) {
			return;
		}
		const p = this.toNumber(getMetrics(previous));
		const c = this.toNumber(getMetrics(data));

		if (p === undefined || c === undefined) {
			return;
		}
		return styleRatio(c / p, this.style, this.meta);
	}
}

function preprocess(summary: Summary, options: SummaryTableOptions) {
	const { outliers = "all" } = options;

	for (const item of summary.results) {
		const rawMetrics = Summary.getMetrics(item);
		const metrics = Object.create(rawMetrics);
		item[kProcessedMetrics] = metrics;

		for (const meta of summary.meta.values()) {
			const value = metrics[meta.key];
			if (!Array.isArray(value)) {
				continue;
			}
			value.sort((a, b) => a - b);
			if (outliers && meta.analysis === 2) {
				removeOutliers(summary, outliers, item, meta);
			}
		}
	}
}

function removeOutliers(summary: Summary, outliers: Outliers, row: FlattedResult, meta: MetricMeta) {
	const before = row[kProcessedMetrics][meta.key];

	const mode = outliers === "all"
		? "all"
		: (outliers === "best") === meta.lowerIsBetter
			? "lower" : "upper";

	const after = new TukeyOutlierDetector(before).filter(before, mode);
	row[kProcessedMetrics][meta.key] = after;

	const removed = before.length - after.length;
	if (removed !== 0) {
		summary.notes.push({ type: "info", case: row, text: `${removed} outliers were removed.` });
	}
}

export interface FormatOptions {
	/**
	 * How to apply style to cell, it is also the place for escaping.
	 *
	 * Values have associated colors in the table will be converted using
	 * `stainer[color](value)`, others using `stainer(value)`.
	 *
	 * By default, it will just return the value as is.
	 */
	stainer?: Stainer;

	/**
	 * Allow values in the column have different unit.
	 *
	 * @default false
	 * @example
	 *    (flexUnit = false)       (flexUnit = true)
	 * |   name |      time |   |   name |       time |
	 * | -----: | --------: |   | -----: | ---------: |
	 * | object | 938.45 ms |   | object |  938.45 ms |
	 * |    map |    1.03 s |   |    map | 1031.22 ms |
	 */
	flexUnit?: boolean;
}

export interface FormattedTable extends Array<string[]> {
	/**
	 * Render this table to the source code of a Markdown table.
	 *
	 * @param stringLength Function to detect the length of cell content.
	 */
	toMarkdown(stringLength?: (s: string) => number): string;
}

const formatRE = /^\{(\w+)(?:\.(\w+))?}/;

type FormatFn = (value: any) => string;

const formatters: Record<string, UnitConvertor> = {
	number: decimalPrefix,
	duration: durationFmt,
	dataSize: dataSizeIEC,
};

export function parseFormat(template: string) {
	const match = formatRE.exec(template);
	if (match) {
		const [p, type, rawUnit] = match;
		return {
			formatter: formatters[type],
			rawUnit,
			suffix: template.slice(p.length),
		};
	}
	throw new Error("Invalid metric format: " + template);
}

function formatColumn(table: CellValue[][], column: number, template: string, flex: boolean) {
	const numbers: number[] = [];
	for (const row of table) {
		const value = row[column];
		if (typeof value === "string") {
			throw new TypeError(`Cannot apply number format to "${value}"`);
		}
		if (typeof value === "number") {
			numbers.push(value);
		}
	}

	const { formatter, rawUnit, suffix } = parseFormat(template);
	let format: FormatFn;
	if (flex) {
		format = (value: number) => separateThousand(formatter.formatDiv(value, rawUnit));
	} else {
		const fixed = formatter.homogeneous(numbers, rawUnit);
		format = (value: number) => separateThousand(fixed.format(value));
	}

	for (const row of table) {
		const value = row[column];
		row[column] = value === undefined ? "" : format(value) + suffix;
	}
}

function toMarkdown(this: string[][], stringLength: any) {
	return markdownTable(this, { stringLength, align: "r" });
}

export class SummaryTable {

	private readonly formats: Array<string | undefined>;
	private readonly groupEnds: number[] = [];
	private readonly colors: CellColor[][] = [];

	readonly cells: CellValue[][] = [];

	readonly hints: string[] = [];
	readonly warnings: string[] = [];

	/**
	 * Build SummaryTable of a suite from its benchmark result.
	 *
	 * @param result Results of the suite with toolchains.
	 * @param diff Used to generate *.diff columns.
	 * @param options The options, see its type for details.
	 */
	static from(result: ToolchainResult[], diff?: ToolchainResult[], options: SummaryTableOptions = {}) {
		const { stdDev = true, percentiles = [], ratioStyle = "percentage" } = options;

		const summary = new Summary(result);
		const prev = new Summary(diff || []);
		const { baseline } = summary;

		const columnDefs: ColumnFactory[] = [new RowNumberColumn()];
		for (const [p, v] of summary.vars.entries()) {
			if (options.showSingle || v.size > 1) {
				columnDefs.push(new VariableColumn(p));
			}
		}
		for (const meta of summary.meta.values()) {
			columnDefs.push(new RawMetricColumn(meta));
			if (!meta.analysis /* None or undefined */) {
				continue;
			}
			if (meta.analysis === MetricAnalysis.Statistics) {
				if (stdDev) {
					columnDefs.push(new StdDevColumn(meta));
				}
				for (const k of percentiles) {
					columnDefs.push(new PercentileColumn(meta, k));
				}
			}
			if (baseline) {
				const { type, value } = baseline;

				// Variable names should be consistent and cannot be filtered,
				const values = summary.vars.get(type);
				if (!values) {
					throw new Error(`${type} is not in variables`);
				}

				if (values.has(value)) {
					columnDefs.push(new BaselineColumn(meta, baseline, ratioStyle));
				} else {
					summary.notes.push({
						type: "warn",
						text: `Baseline { ${type}: ${value} } does not in the results.`,
					});
				}
			}
			// Assume the meta has not changed.
			if (prev.meta.has(meta.key)) {
				columnDefs.push(new DifferenceColumn(prev, meta, ratioStyle));
			}
		}

		preprocess(summary, options);
		preprocess(prev, options);

		return new SummaryTable(summary, columnDefs);
	}

	constructor(summary: Summary, columnDefs: ColumnFactory[]) {
		this.formats = columnDefs.map(c => c.format);

		let colorRow: CellColor[];
		let row: CellValue[];

		const addRow = () => {
			this.cells.push(row = []);
			this.colors.push(colorRow = []);
		};

		function push(vc?: ColoredValue) {
			if (vc === undefined) {
				row.push(undefined);
				colorRow.push(null);
			} else if (Array.isArray(vc)) {
				row.push(vc[0]);
				colorRow.push(vc[1]);
			} else {
				row.push(vc);
				colorRow.push(null);
			}
		}

		addRow();
		for (const column of columnDefs) {
			push(column.name);
		}

		const rawGroups = summary.baseline
			? summary.split(summary.baseline.type).values()
			: [summary.results];

		for (const group of rawGroups) {
			for (const metricColumn of columnDefs) {
				metricColumn.prepare?.(group);
			}
			for (const result of group) {
				addRow();
				for (const column of columnDefs) {
					push(column.getValue(result));
				}
			}
			this.groupEnds.push(this.cells.length);
		}

		const { hints, warnings } = this;
		for (const note of summary.notes) {
			const c = note.case;
			const scope = c ? `[No.${c[kRowNumber]}] ${c.Name}: ` : "";
			const message = scope + note.text;
			(note.type === "info" ? hints : warnings).push(message);
		}
	}

	/**
	 * Format the table for better presentation, it will perform:
	 * - Add an empty line between groups.
	 * - Convert numeric values to string with units if possible.
	 * - Apply colors to cells, using `options.stainer`.
	 */
	format(options: FormatOptions = {}) {
		const { formats, cells, colors, groupEnds } = this;
		const { flexUnit = false, stainer = noColors } = options;
		const table = [[]] as unknown as FormattedTable;

		function applyStyle(value: any, r: number, c: number) {
			const x = colors[r][c];
			return x ? stainer[x](value) : stainer(value);
		}

		for (let i = 0; i < formats.length; i++) {
			const v = cells[0][i];
			table[0].push(applyStyle(v, 0, i));
		}

		const separator = new Array(formats.length);
		let offset = 1;
		for (const e of groupEnds) {
			const copy = cells.slice(offset, e).map(r => r.slice());

			for (let i = 0; i < formats.length; i++) {
				if (formats[i]) {
					formatColumn(copy, i, formats[i]!, flexUnit);
				}
				for (let j = 0; j < copy.length; j++) {
					const v = copy[j][i];
					copy[j][i] = applyStyle(v, offset + j, i);
				}
			}

			offset = e;
			table.push(...copy as string[][], separator);
		}
		table.pop();
		table.toMarkdown = toMarkdown;
		return table;
	}
}
