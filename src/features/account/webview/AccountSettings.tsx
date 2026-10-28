import { createSignal, onCleanup, For, Match, Switch } from "solid-js";
import { sendInitialized } from "./api";
import { ProfileSection } from "./sections/ProfileSection";
import { EmailsSection } from "./sections/EmailsSection";
import { SecuritySection } from "./sections/SecuritySection";
import { LinkedAccountsSection } from "./sections/LinkedAccountsSection";
import { DangerZoneSection, initializeDangerZone } from "./sections/DangerZoneSection";
import * as S from "effect/Schema";
import { Option } from "effect";
import { InitState, type SectionId } from "../types";

interface NavSection {
  id: SectionId;
  label: string;
  icon: string;
}

const sections: NavSection[] = [
  { id: "profile", label: "Profile", icon: "codicon-account" },
  { id: "emails", label: "Emails", icon: "codicon-mail" },
  { id: "security", label: "Security", icon: "codicon-lock" },
  { id: "linked-accounts", label: "Linked Accounts", icon: "codicon-link" },
  { id: "danger-zone", label: "Danger Zone", icon: "codicon-warning" },
];

export const AccountSettings = () => {
  const [activeSection, setActiveSection] = createSignal<SectionId>("profile");

  const handleMessage = (event: MessageEvent) => {
    Option.map(S.decodeUnknownOption(InitState)(event.data), (message) => {
      Option.map(message.section, setActiveSection);
      initializeDangerZone(message.deleteToken);
    });
  };

  window.addEventListener("message", handleMessage);
  sendInitialized();
  onCleanup(() => window.removeEventListener("message", handleMessage));

  return (
    <div
      class="settings-container"
      data-pw="account-settings-root"
      data-pw-section={activeSection()}
    >
      <nav class="settings-nav">
        <div class="nav-header">Account Settings</div>
        <For each={sections}>
          {(section) => (
            <button
              class={`nav-item ${activeSection() === section.id ? "nav-item-active" : ""}`}
              onClick={() => setActiveSection(section.id)}
              data-pw={`account-nav-${section.id}`}
            >
              <i class={`codicon ${section.icon}`} />
              <span>{section.label}</span>
            </button>
          )}
        </For>
      </nav>
      <main class="settings-content">
        <Switch>
          <Match when={activeSection() === "profile"}>
            <ProfileSection />
          </Match>
          <Match when={activeSection() === "emails"}>
            <EmailsSection />
          </Match>
          <Match when={activeSection() === "security"}>
            <SecuritySection />
          </Match>
          <Match when={activeSection() === "linked-accounts"}>
            <LinkedAccountsSection />
          </Match>
          <Match when={activeSection() === "danger-zone"}>
            <DangerZoneSection />
          </Match>
        </Switch>
      </main>
    </div>
  );
};
