import * as Effect from "effect/Effect";
import { render } from "fibrae";
import { AuthPanel } from "./AuthPanel";
import "./styles.css";

const container = document.getElementById("root");
if (container) {
  Effect.runFork(render(<AuthPanel />, container));
}
