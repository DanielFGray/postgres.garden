import { render } from "@solidjs/web";
import { PlaygroundListView } from "./PlaygroundListView";
import "./styles.css";

const container = document.getElementById("root");
if (container) {
  render(() => <PlaygroundListView />, container);
}
