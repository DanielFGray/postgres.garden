import { Elysia } from "elysia";
import Docker from "dockerode";
import net from "node:net";
import fs from "node:fs";
import stream from "node:stream";

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

async function createContainer() {
  const pullStream = await docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(pullStream, (err) => (err == null ? resolve() : reject(err)));
  });
  await fs.promises.mkdir("/tmp/workspace", { recursive: true });
  return docker.createContainer({
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
  });
}

async function prepareContainer(container: Docker.Container) {
  await container.start();
  console.log("Installing node");
  const exec = await container.exec({
    Cmd: ["gu", "install", "nodejs"],
    AttachStdout: true,
    AttachStderr: true,
  });
  const execStream = await exec.start({ hijack: true });
  execStream.pipe(process.stdout);
  await new Promise((resolve) => execStream.on("end", resolve));
  console.log("Node installed");
}

console.log("Pulling image/starting container...");
const containerPromise = createContainer();

async function exitHandler() {
  console.log("Exiting...");
  try {
    const c = await containerPromise;
    await c.remove({ force: true });
  } catch (err) {
    console.error(err);
  } finally {
    process.exit();
  }
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

async function findPortFree() {
  return new Promise<number>((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

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
        .then(async () => {
          if (!state.initialized) {
            try {
              state.initialized = true;
              const init = JSON.parse(message) as {
                main: string;
                files: Record<string, string>;
              };
              await Object.entries(init.files).reduce(async (prev, [file, content]) => {
                await prev;
                await fs.promises.writeFile("/tmp/" + file, content);
              }, Promise.resolve());
              const debuggerPort = await findPortFree();
              const exec = await container.exec({
                Cmd: [
                  "node",
                  `--dap=${debuggerPort}`,
                  "--dap.WaitAttached",
                  "--dap.Suspend=false",
                  init.main,
                ],
                AttachStdout: true,
                AttachStderr: true,
              });

              const execStream = await exec.start({ hijack: true });
              const stdout = new stream.PassThrough();
              const stderr = new stream.PassThrough();
              demuxStream(container, execStream, stdout, stderr);

              stdout.on("data", (buf: Buffer) => ws.send(makeOutput("stdout", buf)));
              stderr.on("data", (buf: Buffer) => ws.send(makeOutput("stderr", buf)));

              execStream.on("end", () => ws.close());

              await new Promise((resolve) => setTimeout(resolve, 1000));
              state.dapSocket.connect(debuggerPort);
            } catch (err) {
              console.error("Failed to initialize", err);
            }
            return;
          }
          state.dapSocket.sendMessage(message);
        })
        .catch(() => {});
    },

    close(ws) {
      connections.delete(ws.id);
    },
  })
  .listen(PORT, () => {
    console.log(`Debug server started on port ${PORT}`);
  });
