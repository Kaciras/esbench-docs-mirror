import { ChildProcess, exec } from "child_process";
import { once } from "events";
import { createServer, Server } from "http";
import { json } from "stream/consumers";
import { AddressInfo } from "net";
import { writeFileSync } from "fs";
import { basename, join, relative } from "path";
import { ExecuteOptions, Executor } from "../host/toolchain.js";

type GetCommand = (file: string) => string;

const template = `\
import connect from "./__ENTRY__";

function postMessage(message) {
    return fetch(__ADDRESS__, {
        method: "POST",
        body: JSON.stringify(message),
    });
}

connect(postMessage, __FILES__, __PATTERN__);`;

function parseFilename(command: string) {
	const quoted = /^"(.+?)(?<!\\)"/.exec(command);
	if (quoted) {
		return basename(quoted[1]);
	}
	const i = command.indexOf(" ");
	return basename(i === -1 ? command : command.slice(0, i));
}

/**
 * Call an external JS runtime to run suites, the runtime must support the fetch API.
 */
export default class ProcessExecutor implements Executor {

	protected readonly getCommand: GetCommand;

	protected process!: ChildProcess;
	protected server!: Server;
	protected dispatch!: (message: any) => void;

	/**
	 * Create new ProcessExecutor with a command line template.
	 *
	 * You can pass a string as argument, the entry file will append to the end,
	 * or specific a function accept the entry filename and return the command line.
	 *
	 * @example
	 * // Will execute command: `node --jitless /path/to/your/suite.js`
	 * new ProcessExecutor("node --jitless");
	 *
	 * // Will execute command: `bun /path/to/your/suite.js --foo=bar`
	 * new ProcessExecutor(file => `bun ${file} --foo=bar`);
	 */
	constructor(command: string | GetCommand) {
		this.getCommand = typeof command === "function"
			? command
			: (file) => `${command} ${file}`;
	}

	get name() {
		return parseFilename(this.getCommand("<file>"));
	}

	start() {
		this.server = createServer((request, response) => {
			response.end();
			return json(request).then(this.dispatch);
		});
		this.server.listen();
		return once(this.server, "listening");
	}

	close() {
		this.process.kill();
		this.server.close();
	}

	execute(options: ExecuteOptions) {
		const { tempDir, dispatch } = options;
		this.dispatch = dispatch;

		// No need to make the filename unique because only one executor can run at the same time.
		const file = join(tempDir, "main.js");
		this.writeEntry(file, options);
		return this.executeInProcess(file);
	}

	protected writeEntry(file: string, options: ExecuteOptions) {
		const { tempDir, root, files, pattern } = options;

		const info = this.server.address() as AddressInfo;
		const address = `http://localhost:${info.port}`;

		// relative() from path/posix also uses system-depend slash.
		const specifier = relative(tempDir, join(root, "index.js"));

		writeFileSync(file, template
			.replace("__PATTERN__", JSON.stringify(pattern))
			.replace("__ADDRESS__", JSON.stringify(address))
			.replace("__FILES__", JSON.stringify(files))
			.replace("__ENTRY__", specifier.replaceAll("\\", "/")));
	}

	protected async executeInProcess(entry: string) {
		const command = this.getCommand(entry);
		this.process?.kill();
		this.process = exec(command);

		const [code] = await once(this.process, "exit");
		if (code !== 0) {
			throw new Error(`Execute Failed (${code}), Command: ${command}`);
		}
	}
}
