import * as esbuild from "esbuild";
import { NodeRuntime } from "@effect/platform-node";
import { Effect, Schema } from "effect";

class BuildError extends Schema.TaggedError<BuildError, { readonly brand: unique symbol }>()(
  "BuildError",
  {
    message: Schema.String,
  },
) {}

// esbuild inlines process.env.NODE_ENV at build time, so a production build must define it.
const isProductionBuild = import.meta.env?.NODE_ENV === "production";

const config: esbuild.BuildOptions = {
  bundle: true,
  format: "esm",
  target: "node22",
  packages: "external",
  outfile: "./dist/server.js",
  entryPoints: ["./server/index.ts"],
  sourcemap: true,
  define: isProductionBuild ? { "process.env.NODE_ENV": '"production"' } : undefined,
};

/** Runs one esbuild call, naming the stage that failed. */
const step = <A>(stage: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      new BuildError({
        message: `${stage} failed: ${error instanceof Error ? error.message : String(error)}`,
      }),
  });

const runBuild = Effect.gen(function* () {
  yield* Effect.log("Starting build...");
  yield* step("Build", () => esbuild.build(config));
  yield* Effect.log("Build completed successfully");
});

const runWatch = Effect.gen(function* () {
  yield* Effect.log("Starting watch mode...");
  const ctx = yield* step("Context creation", () => esbuild.context(config));
  yield* step("Watch", () => ctx.watch());
  yield* Effect.log("Watching for changes...");
  // Watching ends only when the process is interrupted.
  return yield* Effect.never;
});

const program = process.argv.includes("--watch") ? runWatch : runBuild;

program.pipe(
  Effect.tapError((error) => Effect.logError(error.message)),
  NodeRuntime.runMain,
);
