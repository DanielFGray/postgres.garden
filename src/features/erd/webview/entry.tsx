import { render } from "preact";
import { ERDViewer } from "./index";
import "./styles.css";

// Mount the app
const container = document.getElementById("root");
if (container) {
  render(<ERDViewer />, container);
}
