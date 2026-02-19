import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "fibrae";
import { sendInitialized } from "./api";
import { ProfileSection } from "./sections/ProfileSection";
import { EmailsSection } from "./sections/EmailsSection";
import { SecuritySection } from "./sections/SecuritySection";
import { LinkedAccountsSection } from "./sections/LinkedAccountsSection";
import { DangerZoneSection } from "./sections/DangerZoneSection";

type SectionId = "profile" | "emails" | "security" | "linked-accounts" | "danger-zone";

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

const activeSectionAtom = Atom.make<SectionId>("profile");

// Tell extension we're ready
sendInitialized();

function renderSection(activeSection: SectionId) {
  switch (activeSection) {
    case "profile":
      return <ProfileSection />;
    case "emails":
      return <EmailsSection />;
    case "security":
      return <SecuritySection />;
    case "linked-accounts":
      return <LinkedAccountsSection />;
    case "danger-zone":
      return <DangerZoneSection />;
  }
}

export const AccountSettings = () =>
  Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry;
    const activeSection = yield* Atom.get(activeSectionAtom);

    return (
      <div class="settings-container">
        <nav class="settings-nav">
          <div class="nav-header">Account Settings</div>
          {sections.map((section) => (
            <button
              key={section.id}
              class={`nav-item ${activeSection === section.id ? "nav-item-active" : ""}`}
              onClick={() => {
                registry.set(activeSectionAtom, section.id);
              }}
            >
              <i class={`codicon ${section.icon}`} />
              <span>{section.label}</span>
            </button>
          ))}
        </nav>
        <main class="settings-content">{renderSection(activeSection)}</main>
      </div>
    );
  });
