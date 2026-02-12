import { render } from "preact";
import { PlaygroundEditorPanel } from "./PlaygroundEditorPanel";
import "./styles.css";

// Mount the app
const container = document.getElementById("root");
if (container) {
  render(<PlaygroundEditorPanel />, container);
}
