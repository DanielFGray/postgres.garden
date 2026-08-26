import { Elysia } from "elysia";
import Docker from "dockerode";
import net from "net";
import stream from "stream";
import { Effect } from "effect";
import * as S from "effect/Schema";

const PORT = 5555;

/** Typed wrapper for dockerode's untyped `container.modem.demuxStream` */
function demuxStream(
  container: Docker.Container,
  input: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): void {
  (
    container.modem as {
      demuxStream(
        s: NodeJS.ReadableStream,
        o: NodeJS.WritableStream,
        e: NodeJS.WritableStream,
      ): void;
    }
  ).demuxStream(input, stdout, stderr);
}

const docker = new Docker();
const image = "ghcr.io/graalvm/graalvm-ce:21.2.0";
const fs = process.getBuiltinModule("fs");
const tryPromise = <A>(run: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => String(cause) });
const Init = S.Struct({ main: S.String, files: S.Record({ key: S.String, value: S.String }) });

function createContainer() {
  return Effect.runPromise(
    Effect.gen(function* () {
      const pullStream = yield* tryPromise(() => docker.pull(image));
      yield* Effect.async<void, string>((resume) => {
        docker.modem.followProgress(pullStream, (err) =>
          resume(err == null ? Effect.void : Effect.fail(String(err))),
        );
      });
      yield* tryPromise(() => fs.promises.mkdir("/tmp/workspace", { recursive: true }));
      return yield* tryPromise(() =>
        docker.createContainer({
          name: "graalvm-debugger",
          Image: image,
          Entrypoint: ["sleep", "infinity"],
          HostConfig: {
            NetworkMode: "host",
            Mounts: [
              {
                Type: "bind",
                Target: "/workspace",
                Source: "/tmp/workspace",
              },
            ],
            AutoRemove: true,
          },
        }),
      );
    }),
  );
}

function prepareContainer(container: Docker.Container) {
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* tryPromise(() => container.start());
      yield* Effect.log("Installing node");
      const exec = yield* tryPromise(() =>
        container.exec({
          Cmd: ["gu", "install", "nodejs"],
          AttachStdout: true,
          AttachStderr: true,
        }),
      );
      const execStream = yield* tryPromise(() => exec.start({ hijack: true }));
      execStream.pipe(process.stdout);
      yield* Effect.async<void>((resume) => {
        execStream.on("end", () => resume(Effect.void));
      });
      yield* Effect.log("Node installed");
    }),
  );
}

Effect.runSync(Effect.log("Pulling image/starting container..."));
const containerPromise = createContainer();

function exitHandler() {
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.log("Exiting...");
      const c = yield* tryPromise(() => containerPromise);
      yield* tryPromise(() => c.remove({ force: true }));
    }).pipe(
      Effect.catchAll((err) => Effect.logError(err)),
      Effect.ensuring(Effect.sync(() => process.exit())),
    ),
  );
}
/* oxlint-disable typescript/no-misused-promises */
process.on("exit", exitHandler);
process.on("SIGINT", exitHandler);
process.on("SIGUSR1", exitHandler);
process.on("SIGUSR2", exitHandler);
process.on("uncaughtException", exitHandler);
/* oxlint-enable typescript/no-misused-promises */

const container = await containerPromise;
await prepareContainer(container);

// --- DAP (Debug Adapter Protocol) socket ---

const TWO_CRLF = "\r\n\r\n";
const HEADER_LINESEPARATOR = /\r?\n/;
const HEADER_FIELDSEPARATOR = /: */;

class DAPSocket {
  private socket: net.Socket;
  private rawData = Buffer.allocUnsafe(0);
  private contentLength = -1;

  constructor(private onMessage: (message: string) => void) {
    this.socket = new net.Socket();
    this.socket.on("data", this.onData);
  }

  private onData = (data: Buffer) => {
    this.rawData = Buffer.concat([this.rawData, data]);
    while (true) {
      if (this.contentLength >= 0) {
        if (this.rawData.length >= this.contentLength) {
          const message = this.rawData.toString("utf8", 0, this.contentLength);
          this.rawData = this.rawData.subarray(this.contentLength);
          this.contentLength = -1;
          if (message.length > 0) {
            this.onMessage(message);
          }
          continue;
        }
      } else {
        const idx = this.rawData.indexOf(TWO_CRLF);
        if (idx !== -1) {
          const header = this.rawData.toString("utf8", 0, idx);
          const lines = header.split(HEADER_LINESEPARATOR);
          lines.forEach((h) => {
            const kvPair = h.split(HEADER_FIELDSEPARATOR);
            if (kvPair[0] === "Content-Length") {
              this.contentLength = Number(kvPair[1]);
            }
          });
          this.rawData = this.rawData.subarray(idx + TWO_CRLF.length);
          continue;
        }
      }
      break;
    }
  };

  public connect(port: number) {
    this.socket.connect(port);
  }

  public sendMessage(message: string) {
    this.socket.write(
      `Content-Length: ${Buffer.byteLength(message, "utf8")}${TWO_CRLF}${message}`,
      "utf8",
    );
  }
}

// --- Helpers ---

const findPortFree = Effect.async<number>((resume) => {
  const srv = net.createServer();
  srv.listen(0, () => {
    const port = (srv.address() as net.AddressInfo).port;
    srv.close(() => resume(Effect.succeed(port)));
  });
});

export type OutputMessage = {
  type: "event";
  event: "output";
  body: {
    category: "stdout" | "stderr";
    output: string;
  };
};

function makeOutput(category: "stdout" | "stderr", output: Buffer) {
  return JSON.stringify({
    type: "event",
    event: "output",
    body: { category, output: output.toString() },
  } satisfies OutputMessage);
}

// --- Per-connection state ---

interface ConnectionState {
  dapSocket: DAPSocket;
  initialized: boolean;
  queue: Promise<void>;
}

const connections = new Map<string, ConnectionState>();

// --- Server ---

new Elysia()
  .ws("/ws", {
    open(ws) {
      const dapSocket = new DAPSocket((msg) => ws.send(msg));
      connections.set(ws.id, {
        dapSocket,
        initialized: false,
        queue: Promise.resolve(),
      });
    },

    message(ws, raw) {
      const state = connections.get(ws.id);
      if (!state) return;

      const message = typeof raw === "string" ? raw : String(raw);

      // Process messages sequentially per connection
      state.queue = state.queue
        .then(() => {
          return Effect.runPromise(
            Effect.gen(function* () {
              if (!state.initialized) {
                state.initialized = true;
                const init = yield* S.decodeUnknown(S.parseJson(Init))(message);
                yield* Effect.forEach(
                  Object.entries(init.files),
                  ([file, content]) =>
                    tryPromise(() => fs.promises.writeFile("/tmp/" + file, content)),
                  { concurrency: 1 },
                );
                const debuggerPort = yield* findPortFree;
                const exec = yield* tryPromise(() =>
                  container.exec({
                    Cmd: [
                      "node",
                      `--dap=${debuggerPort}`,
                      "--dap.WaitAttached",
                      "--dap.Suspend=false",
                      init.main,
                    ],
                    AttachStdout: true,
                    AttachStderr: true,
                  }),
                );

                const execStream = yield* tryPromise(() => exec.start({ hijack: true }));
                const stdout = new stream.PassThrough();
                const stderr = new stream.PassThrough();
                demuxStream(container, execStream, stdout, stderr);

                stdout.on("data", (buf: Buffer) => ws.send(makeOutput("stdout", buf)));
                stderr.on("data", (buf: Buffer) => ws.send(makeOutput("stderr", buf)));

                execStream.on("end", () => ws.close());

                yield* Effect.sleep("1 second");
                yield* Effect.sync(() => state.dapSocket.connect(debuggerPort));
                return;
              }
              yield* Effect.sync(() => state.dapSocket.sendMessage(message));
            }).pipe(Effect.catchAll((err) => Effect.logError("Failed to initialize", err))),
          );
        })
        .catch(() => {});
    },

    close(ws) {
      connections.delete(ws.id);
    },
  })
  .listen(PORT, () => {
    Effect.runSync(Effect.log(`Debug server started on port ${PORT}`));
  });
