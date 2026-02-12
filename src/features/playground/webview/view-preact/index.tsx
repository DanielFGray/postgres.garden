import { render } from "preact";
import { PlaygroundListView } from "./PlaygroundListView";
import "./styles.css";

// Mount the app
const container = document.getElementById("root");
if (container) {
  render(<PlaygroundListView />, container);
}
