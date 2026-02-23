import { Effect, Layer } from "effect";
import { VSCodeService } from "../vscode/service";

const activateAiFeature = (vscode: typeof import("vscode")) => {
  vscode.commands.registerCommand("aiSuggestedCommand", () => {
    vscode.window.showInformationMessage("Hello", {
      detail: "You just run the AI suggested command",
      modal: true,
    });
  });
  vscode.ai.registerRelatedInformationProvider(vscode.RelatedInformationType.CommandInformation, {
    provideRelatedInformation() {
      return [
        {
          type: vscode.RelatedInformationType.CommandInformation,
          command: "aiSuggestedCommand",
          weight: 9999,
        },
      ];
    },
  });
};

export const AiFeatureLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const vscodeService = yield* VSCodeService;
    yield* Effect.sync(() => {
      activateAiFeature(vscodeService.api);
    });
  }),
);
