import * as Effect from "effect/Effect";
import { render } from "fibrae";
import { ERDViewer } from "./index";
import "./styles.css";

// Mount the app
const container = document.getElementById("root");
if (container) {
  Effect.runFork(render(<ERDViewer />, container));
}
