import { createSignal, refresh, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { apiCall } from "../api";
import { formText } from "../format";
import { createRequest, runRequest } from "../../../webview/request";
import { SectionBoundary } from "../SectionBoundary";

const loadPasswordStatus = () =>
  apiCall("account.security.load_password_status", (api) => api.apiUsers.meHasPassword({}));

export const SecuritySection = () => {
  const status = createRequest(loadPasswordStatus);
  const [saving, setSaving] = createSignal(false);
  const [mutationError, setMutationError] = createSignal<string | null>(null);
  const [success, setSuccess] = createSignal<string | null>(null);

  const handleSubmit: JSX.EventHandler<HTMLFormElement, SubmitEvent> = (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const newPassword = formText(data, "newPassword");
    const confirmPassword = formText(data, "confirmPassword");

    setMutationError(null);
    setSuccess(null);

    if (newPassword.length < 8) {
      setMutationError("New password must be at least 8 characters");
      return;
    }
    if (newPassword !== confirmPassword) {
      setMutationError("Passwords do not match");
      return;
    }

    // Safe to read directly: the form only exists once the request resolved.
    const hasPassword = status().has_password;
    setSaving(true);
    void runRequest(
      apiCall("account.security.change_password", (api) =>
        api.apiUsers.changePassword({
          payload: {
            oldPassword: hasPassword ? formText(data, "oldPassword") : "",
            newPassword,
          },
        }),
      ),
    )
      .then(
        () => {
          setSuccess(hasPassword ? "Password changed successfully" : "Password set successfully");
          void refresh(status);
          form.reset();
        },
        (error: Error) => setMutationError(error.message),
      )
      .finally(() => setSaving(false));
  };

  return (
    <SectionBoundary loading="Loading security settings..." retry={() => refresh(status)}>
      <div class="security-section" data-pw="security-section">
        <div class="section-header">
          <h2>{status().has_password ? "Change Password" : "Set Password"}</h2>
        </div>

        <Show when={!status().has_password}>
          <p
            style={{
              color: "var(--vscode-descriptionForeground)",
              "font-style": "italic",
              margin: "0 0 12px",
            }}
          >
            You signed up with GitHub. Set a password to also log in with email.
          </p>
        </Show>

        <form onSubmit={handleSubmit} data-pw="change-password-form">
          <Show when={status().has_password}>
            <div class="field">
              <label>Current Password</label>
              <input
                type="password"
                name="oldPassword"
                class="setting-input"
                data-pw="settings-oldPassword-input"
              />
            </div>
          </Show>

          <div class="field">
            <label>New Password</label>
            <input
              type="password"
              name="newPassword"
              class="setting-input"
              data-pw="settings-password-input"
            />
          </div>

          <div class="field">
            <label>Confirm New Password</label>
            <input
              type="password"
              name="confirmPassword"
              class="setting-input"
              data-pw="settings-confirmPassword-input"
            />
          </div>

          <Show when={mutationError()}>
            {(message) => (
              <div
                class="section-error"
                style={{ margin: "8px 0" }}
                data-pw="settings-change-password-error"
              >
                <i class="codicon codicon-error" />
                <span>{message()}</span>
              </div>
            )}
          </Show>

          <Show when={success()}>
            {(message) => (
              <div
                style={{ color: "var(--vscode-charts-green)", margin: "8px 0" }}
                data-pw="settings-change-password-success"
              >
                <i class="codicon codicon-check" /> {message()}
              </div>
            )}
          </Show>

          <button
            class="button"
            type="submit"
            disabled={saving()}
            data-pw="settings-change-password-submit"
          >
            {saving() ? "Saving..." : status().has_password ? "Change Password" : "Set Password"}
          </button>
        </form>
      </div>
    </SectionBoundary>
  );
};
