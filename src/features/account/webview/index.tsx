import { render } from "@solidjs/web";
import { AccountSettings } from "./AccountSettings";
import "./styles.css";

const container = document.getElementById("root");
if (container) {
  render(() => <AccountSettings />, container);
}
