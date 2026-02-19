import * as Effect from "effect/Effect";
import { render } from "fibrae";
import { PlaygroundListView } from "./PlaygroundListView";
import "./styles.css";

// Mount the app
const container = document.getElementById("root");
if (container) {
  Effect.runFork(render(<PlaygroundListView />, container));
}
