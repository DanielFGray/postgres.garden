import * as Effect from "effect/Effect";
import { render } from "fibrae";
import { AccountSettings } from "./AccountSettings";
import "./styles.css";

const container = document.getElementById("root");
if (container) {
  Effect.runFork(render(<AccountSettings />, container));
}
