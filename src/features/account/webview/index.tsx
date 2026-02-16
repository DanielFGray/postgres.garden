import { render } from "preact";
import { AccountSettings } from "./AccountSettings";
import "./styles.css";

const container = document.getElementById("root");
if (container) {
  render(<AccountSettings />, container);
}
