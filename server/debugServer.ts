import { WebSocketServer } from "ws";
import Docker from "dockerode";
import { Effect } from "effect";
import * as S from "effect/Schema";
import net from "node:net";
// dockerode's modem exchanges Node streams, and Effect has no equivalent to hand it.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import stream from "node:stream";

const PORT = 5555;
const http = process.getBuiltinModule("http");
const fs = process.getBuiltinModule("fs");
const tryPromise = <A>(run: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => String(cause) });
const Init = S.Struct({ main: S.String, files: S.Record(S.String, S.String) });

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

function routeHandler(handler: (req: any, res: any) => string) {
  return (req: any, res: any) => {
    try {
      const response = handler(req, res);
      if (response) res.write(response);
      res.end();
    } catch {
      res.writeHead(500);
      res.write("Internal server error");
      res.end();
    }
  };
}

const server = http.createServer(
  routeHandler((req, res) => {
    switch (`${req.method} ${req.url}`) {
      default:
        res.writeHead(404);
        return "Not found";
    }
  }),
);

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  const socket = new DAPSocket((message) => ws.send(message));

  let initialized = false;

  ws.on(
    "message",
    // oxlint-disable-next-line typescript/no-misused-promises
    sequential((message: string) =>
      Effect.runPromise(
        Effect.gen(function* () {
          if (!initialized) {
            initialized = true;
            const init = yield* S.decodeEffect(S.fromJsonString(Init))(message);
            for (const [file, content] of Object.entries(init.files)) {
              yield* tryPromise(() => fs.promises.writeFile("/tmp/" + file, content));
            }
            const debuggerPort = yield* findPortFree;
            const exec = yield* tryPromise(() =>
              container.exec({
                Cmd: [
                  "node",
                  `--dap=${debuggerPort}`,
                  "--dap.WaitAttached",
                  "--dap.Suspend=false",
                  `${init.main}`,
                ],
                AttachStdout: true,
                AttachStderr: true,
              }),
            );

            const execStream = yield* tryPromise(() =>
              exec.start({
                hijack: true,
              }),
            );
            const stdout = new stream.PassThrough();
            const stderr = new stream.PassThrough();
            demuxStream(container, execStream, stdout, stderr);

            stdout.on("data", (buffer: Buffer) => ws.send(makeOutput("stdout", buffer)));
            stderr.on("data", (buffer: Buffer) => ws.send(makeOutput("stderr", buffer)));

            execStream.on("end", () => {
              ws.close();
            });

            yield* Effect.sleep("1 second");
            yield* Effect.sync(() => socket.connect(debuggerPort));

            return;
          }
          socket.sendMessage(message);
        }).pipe(Effect.catch((err) => Effect.logError("Failed to initialize", err))),
      ),
    ),
  );
});
server.listen(PORT, () => {
  Effect.runSync(Effect.log(`Server started on port ${PORT} :)`));
});

const docker = new Docker();
const image = "ghcr.io/graalvm/graalvm-ce:21.2.0";

function createContainer() {
  return Effect.runPromise(
    Effect.gen(function* () {
      const stream = yield* tryPromise(() => docker.pull(image));
      yield* Effect.callback<void, string>((resume) => {
        docker.modem.followProgress(stream, (err) =>
          resume(err == null ? Effect.void : Effect.fail(String(err))),
        );
      });
      yield* tryPromise(() =>
        fs.promises.mkdir("/tmp/workspace", {
          recursive: true,
        }),
      );
      const container = yield* tryPromise(() =>
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
      return container;
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
      const execStream = yield* tryPromise(() =>
        exec.start({
          hijack: true,
        }),
      );
      execStream.pipe(process.stdout);
      yield* Effect.callback<void>((resume) => {
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
      const container = yield* tryPromise(() => containerPromise);
      yield* tryPromise(() =>
        container.remove({
          force: true,
        }),
      );
    }).pipe(
      Effect.catch((err) => Effect.logError(err)),
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
          for (const h of lines) {
            const kvPair = h.split(HEADER_FIELDSEPARATOR);
            if (kvPair[0] === "Content-Length") {
              this.contentLength = Number(kvPair[1]);
            }
          }
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

const TWO_CRLF = "\r\n\r\n";
const HEADER_LINESEPARATOR = /\r?\n/;
const HEADER_FIELDSEPARATOR = /: */;

const findPortFree = Effect.callback<number>((resume) => {
  const srv = net.createServer();
  srv.listen(0, () => {
    const port = (srv.address() as net.AddressInfo).port;
    srv.close(() => resume(Effect.succeed(port)));
  });
});

function sequential<T, P extends unknown[]>(
  fn: (...params: P) => Promise<T>,
): (...params: P) => Promise<T> {
  let promise = Promise.resolve();
  return (...params: P) => {
    const result = promise.then(() => {
      return fn(...params);
    });

    promise = result.then(
      () => {},
      () => {},
    );
    return result;
  };
}

export type Message = {
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
    body: {
      category,
      output: output.toString(),
    },
  } satisfies Message);
}
