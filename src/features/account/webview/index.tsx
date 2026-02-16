import { render } from "preact";
import { AccountSettings } from "./AccountSettings";
import styles from "./styles.css?inline";

const container = document.getElementById("root");
if (container) {
  document.body.style.margin = "0";
  document.body.style.padding = "0";
  document.body.style.height = "100vh";

  container.style.height = "100vh";
  container.style.display = "block";

  const shadowRoot = container.attachShadow({ mode: "open" });
  const codiconHref = container.getAttribute("data-codicons");

  if (codiconHref) {
    const codiconLink = document.createElement("link");
    codiconLink.rel = "stylesheet";
    codiconLink.href = codiconHref;
    shadowRoot.appendChild(codiconLink);
  }

  const styleTag = document.createElement("style");
  styleTag.textContent = styles;
  shadowRoot.appendChild(styleTag);

  const appRoot = document.createElement("div");
  appRoot.className = "settings-root";
  shadowRoot.appendChild(appRoot);

  render(<AccountSettings />, appRoot);
}
