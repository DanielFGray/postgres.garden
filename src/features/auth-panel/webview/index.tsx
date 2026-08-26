import { render } from "@solidjs/web";
import { AuthPanel } from "./AuthPanel";
import "./styles.css";

const container = document.getElementById("root");
if (container) {
  render(() => <AuthPanel />, container);
}
