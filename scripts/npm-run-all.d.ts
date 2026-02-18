declare module "npm-run-all" {
  interface RunAllOptions {
    stdin?: NodeJS.ReadableStream;
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
    silent?: boolean;
  }
  export default function runAll(scripts: string[], options?: RunAllOptions): Promise<void>;
}
