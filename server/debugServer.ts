import { WebSocketServer } from "ws";
import Docker from "dockerode";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import stream from "node:stream";

const PORT = 5555;

/** Typed wrapper for dockerode's untyped `container.modem.demuxStream` */
function demuxStream(container: Docker.Container, input: NodeJS.ReadableStream, stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream): void {
  (container.modem as { demuxStream(s: NodeJS.ReadableStream, o: NodeJS.WritableStream, e: NodeJS.WritableStream): void }).demuxStream(input, stdout, stderr);
}

function routeHandler(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => string,
) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
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
    sequential(async (message: string) => {
      if (!initialized) {
        try {
          initialized = true;
          const init = JSON.parse(message) as { main: string; files: Record<string, string> };
          for (const [file, content] of Object.entries(init.files)) {
            await fs.promises.writeFile("/tmp/" + file, content);
          }
          const debuggerPort = await findPortFree();
          const exec = await container.exec({
            Cmd: [
              "node",
              `--dap=${debuggerPort}`,
              "--dap.WaitAttached",
              "--dap.Suspend=false",
              `${init.main}`,
            ],
            AttachStdout: true,
            AttachStderr: true,
          });

          const execStream = await exec.start({
            hijack: true,
          });
          const stdout = new stream.PassThrough();
          const stderr = new stream.PassThrough();
          demuxStream(container, execStream, stdout, stderr);

          stdout.on("data", (buffer: Buffer) => ws.send(makeOutput("stdout", buffer)));
          stderr.on("data", (buffer: Buffer) => ws.send(makeOutput("stderr", buffer)));

          execStream.on("end", () => {
            ws.close();
          });

          await new Promise((resolve) => setTimeout(resolve, 1000));
          socket.connect(debuggerPort);

          return;
        } catch (err) {
          console.error("Failed to initialize", err);
        }
      }
      socket.sendMessage(message);
    }),
  );
});
server.listen(PORT, () => {
   
  console.log(`Server started on port ${PORT} :)`);
});

const docker = new Docker();
const image = "ghcr.io/graalvm/graalvm-ce:21.2.0";

async function createContainer() {
  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err) =>
      err == null ? resolve() : reject(err),
    );
  });
  await fs.promises.mkdir("/tmp/workspace", {
    recursive: true,
  });
  const container = await docker.createContainer({
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
  return container;
}

async function prepareContainer(container: Docker.Container) {
  await container.start();
   
  console.log("Installing node");
  const exec = await container.exec({
    Cmd: ["gu", "install", "nodejs"],
    AttachStdout: true,
    AttachStderr: true,
  });
  const execStream = await exec.start({
    hijack: true,
  });
  execStream.pipe(process.stdout);
  await new Promise((resolve) => execStream.on("end", resolve));
   
  console.log("Node installed");
}

 
console.log("Pulling image/starting container...");
const containerPromise = createContainer();

async function exitHandler() {
   
  console.log("Exiting...");
  try {
    const container = await containerPromise;
    await container.remove({
      force: true,
    });
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

async function findPortFree() {
  return new Promise<number>((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

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
