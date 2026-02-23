import { initialize as initializeMonacoService } from "@codingame/monaco-vscode-api";
import getQuickAccessServiceOverride from "@codingame/monaco-vscode-quickaccess-service-override";
import getWorkbenchServiceOverride from "@codingame/monaco-vscode-workbench-service-override";
import { Effect, FiberSet, Schema } from "effect";
import { commonServices, constructOptions, envOptions, initializeCommon } from "./setup.common";

class WorkbenchInitError extends Schema.TaggedError<WorkbenchInitError>()("WorkbenchInitError", {
	step: Schema.String,
	message: Schema.String,
}) {}

const getOrCreateWorkbenchElement = (container: HTMLElement) =>
	Effect.sync(() => {
		if (import.meta.hot?.data.workbenchElement) {
			const el = import.meta.hot.data.workbenchElement as HTMLDivElement;
			container.replaceChildren(el);
			return el;
		}
		const el = document.createElement("div");
		el.style.height = "100vh";
		container.appendChild(el);
		if (import.meta.hot) {
			import.meta.hot.data.workbenchElement = el;
		}
		return el;
	});

const initializeWorkbench = (workbenchElement: HTMLDivElement) =>
	Effect.suspend(() => {
		if (import.meta.hot?.data.monacoInitialized) {
			return Effect.void;
		}

		return Effect.tryPromise({
			try: () =>
				initializeMonacoService(
					{
						...commonServices,
						...getWorkbenchServiceOverride(),
						...getQuickAccessServiceOverride({
							isKeybindingConfigurationVisible: () => true,
							shouldUseGlobalPicker: () => true,
						}),
					},
					workbenchElement,
					constructOptions,
					envOptions,
				),
			catch: (error) =>
				new WorkbenchInitError({
					step: "initializeMonacoService",
					message: error instanceof Error ? error.message : String(error),
				}),
		}).pipe(
			Effect.tap(() =>
				Effect.sync(() => {
					if (import.meta.hot) {
						import.meta.hot.data.monacoInitialized = true;
					}
				}),
			),
		);
	});

export class Workbench extends Effect.Service<Workbench>()("app/Workbench", {
	scoped: Effect.gen(function* () {
		yield* initializeCommon.pipe(
			Effect.withSpan("workbench.initializeCommon"),
			Effect.mapError(
				(error) =>
					new WorkbenchInitError({
						step: "initializeCommon",
						message: error instanceof Error ? error.message : String(error),
					}),
			),
		);

		const container = document.getElementById("workbench-container");
		if (!container) {
			return yield* Effect.die(
				new WorkbenchInitError({ step: "findContainer", message: "#workbench-container not found" }),
			);
		}

		const workbenchElement = yield* getOrCreateWorkbenchElement(container);
		yield* initializeWorkbench(workbenchElement).pipe(Effect.withSpan("workbench.initializeMonaco"));

		const runFork = yield* FiberSet.makeRuntime();
		const runPromise = yield* FiberSet.makeRuntimePromise();

		return { runFork, runPromise } as const;
	}).pipe(Effect.withSpan("workbench.boot")),
}) {}
