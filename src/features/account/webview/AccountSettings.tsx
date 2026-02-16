import { signal } from "@preact/signals";
import { ProfileSection } from "./sections/ProfileSection";

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

const activeSection = signal<SectionId>("profile");

function renderSection() {
  switch (activeSection.value) {
    case "profile":
      return <ProfileSection />;
    case "emails":
      return <PlaceholderSection title="Emails" description="Manage your email addresses, set your primary email, and verify new ones." />;
    case "security":
      return <PlaceholderSection title="Security" description="Change your password or set one if you signed up with GitHub." />;
    case "linked-accounts":
      return <PlaceholderSection title="Linked Accounts" description="Manage OAuth connections to your account." />;
    case "danger-zone":
      return <PlaceholderSection title="Danger Zone" description="Permanently delete your account and all associated data." />;
  }
}

function PlaceholderSection({ title, description }: { title: string; description: string }) {
  return (
    <div class="placeholder-section">
      <div class="section-header">
        <h2>{title}</h2>
      </div>
      <p class="section-description">{description}</p>
      <p class="section-coming-soon">Coming soon</p>
    </div>
  );
}

export function AccountSettings() {
  return (
    <div class="settings-container">
      <nav class="settings-nav">
        <div class="nav-header">Account Settings</div>
        {sections.map((section) => (
          <button
            key={section.id}
            class={`nav-item ${activeSection.value === section.id ? "nav-item-active" : ""}`}
            onClick={() => { activeSection.value = section.id; }}
          >
            <i class={`codicon ${section.icon}`} />
            <span>{section.label}</span>
          </button>
        ))}
      </nav>
      <main class="settings-content">
        {renderSection()}
      </main>
    </div>
  );
}
