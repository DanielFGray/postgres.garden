import { initialize as initializeMonacoService } from "@codingame/monaco-vscode-api";
import getWorkbenchServiceOverride from "@codingame/monaco-vscode-workbench-service-override";
import getQuickAccessServiceOverride from "@codingame/monaco-vscode-quickaccess-service-override";
import { commonServices, constructOptions, envOptions } from "./setup.common";

// Guard against double initialization
let initialized = false;

export async function setupWorkbench(): Promise<void> {
  if (initialized) {
    console.warn("Workbench already initialized, skipping duplicate initialization");
    return;
  }

  initialized = true;

  // Create container with shadow DOM for CSS isolation
  const container = document.createElement("div");
  container.setAttribute("id", "workbench-container");
  container.style.height = "100vh";
  document.body.replaceChildren(container);

  // const shadowRoot = container.attachShadow({
  //   mode: "open",
  // });

  const workbenchElement = document.createElement("div");
  workbenchElement.style.height = "100vh";
  // shadowRoot.appendChild(workbenchElement);
  container.appendChild(workbenchElement);

  // Override services - pass the workbench element inside shadow root
  await initializeMonacoService(
    {
      ...commonServices,
      ...getWorkbenchServiceOverride(),
      ...getQuickAccessServiceOverride({
        isKeybindingConfigurationVisible: () => true,
        shouldUseGlobalPicker: () => true,
      }),
    },
    workbenchElement,
    constructOptions,
    envOptions,
  );
}
