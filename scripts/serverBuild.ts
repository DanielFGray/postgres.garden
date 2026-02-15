import * as esbuild from "esbuild";
import { Effect, Schema } from "effect";

interface BuildOptions extends esbuild.BuildOptions { }

// Error types using Schema.TaggedError
class BuildError extends Schema.TaggedError<BuildError>()("BuildError", {
  message: Schema.String,
}) { }

class ContextError extends Schema.TaggedError<ContextError>()("ContextError", {
  message: Schema.String,
}) { }

class WatchError extends Schema.TaggedError<WatchError>()("WatchError", {
  message: Schema.String,
}) { }

// For production builds, we need to explicitly define NODE_ENV
// because esbuild inlines process.env.NODE_ENV at build time
const isProductionBuild = process.env.NODE_ENV === "production";

const config: BuildOptions = {
  bundle: true,
  format: "esm",
  target: "node22",
  packages: "external",
  outfile: "./dist/server.js",
  entryPoints: ["./server/prod-entry.ts"],
  sourcemap: true,
  // Define NODE_ENV for production builds to ensure isDev is correctly set
  define: isProductionBuild
    ? { "process.env.NODE_ENV": '"production"' }
    : undefined,
  plugins: [
    // {
    //   name: "rebuild-notify",
    //   setup(build) {
    //     build.onEnd((result) => {
    //       console.log(`build ended with ${result.errors.length} errors`);
    //       if (result.errors.length) {
    //         result.errors.forEach((e) => console.error(e));
    //       }
    //     });
    //   },
    // },
  ],
};

const runBuild = Effect.gen(function*() {
  yield* Effect.log("Starting build...");

  const result = yield* Effect.tryPromise({
    try: () => esbuild.build(config),
    catch: (error) =>
      new BuildError({
        message: error instanceof Error ? error.message : String(error),
      }),
  });

  yield* Effect.log("Build completed successfully");
  return result;
});

const runWatch = Effect.gen(function*() {
  yield* Effect.log("Starting watch mode...");

  const ctx = yield* Effect.tryPromise({
    try: () => esbuild.context(config),
    catch: (error) =>
      new ContextError({
        message: error instanceof Error ? error.message : String(error),
      }),
  });

  yield* Effect.tryPromise({
    try: () => ctx.watch(),
    catch: (error) =>
      new WatchError({
        message: error instanceof Error ? error.message : String(error),
      }),
  });

  yield* Effect.log("Watching for changes...");

  // Keep the process alive in watch mode
  yield* Effect.never;
});

const program = Effect.gen(function*() {
  const shouldWatch = process.argv.includes("--watch");

  yield* Effect.if(shouldWatch, {
    onTrue: () => runWatch,
    onFalse: () => runBuild,
  });
});

// Run the program - Effect runtime handles SIGINT/SIGTERM automatically
program.pipe(
  Effect.catchTags({
    BuildError: (error) =>
      Effect.gen(function*() {
        yield* Effect.logError(`Build failed: ${error.message}`);
        yield* Effect.fail(error);
      }),
    ContextError: (error) =>
      Effect.gen(function*() {
        yield* Effect.logError(`Context creation failed: ${error.message}`);
        yield* Effect.fail(error);
      }),
    WatchError: (error) =>
      Effect.gen(function*() {
        yield* Effect.logError(`Watch mode failed: ${error.message}`);
        yield* Effect.fail(error);
      }),
  }),
  Effect.catchAll((error) =>
    Effect.gen(function*() {
      yield* Effect.logError("Unexpected error:");
      yield* Effect.logError(String(error));
      yield* Effect.fail(error);
    }),
  ),
  Effect.runFork,
);
