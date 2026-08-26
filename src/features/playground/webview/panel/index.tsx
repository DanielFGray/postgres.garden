import { render } from "@solidjs/web";
import { PlaygroundEditorPanel } from "./PlaygroundEditorPanel";
import "./styles.css";

const container = document.getElementById("root");
if (container) {
  render(() => <PlaygroundEditorPanel />, container);
}
