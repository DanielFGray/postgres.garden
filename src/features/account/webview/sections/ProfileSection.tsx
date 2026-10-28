import { createSignal, refresh, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { createRequest, runRequest } from "../../../webview/request";
import { SectionBoundary } from "../SectionBoundary";
import { apiCall, loadProfile } from "../api";
import { formatDate, formText } from "../format";

export const ProfileSection = () => {
  const profile = createRequest(() => loadProfile("account.profile.load"));
  const [bioLength, setBioLength] = createSignal(0);
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);

  const handleSubmit: JSX.EventHandler<HTMLFormElement, SubmitEvent> = (e) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setSaving(true);
    setSaveError(null);
    void runRequest(
      apiCall("account.profile.save", (api) =>
        api.apiUsers.patchMe({
          payload: {
            username: formText(data, "username"),
            name: formText(data, "name"),
            bio: formText(data, "bio"),
            avatar_url: formText(data, "avatar_url"),
          },
        }),
      ),
    )
      .then(
        () => refresh(profile),
        (error: Error) => setSaveError(error.message),
      )
      .finally(() => setSaving(false));
  };

  return (
    <SectionBoundary loading="Loading profile..." retry={() => refresh(profile)}>
      <div class="profile-section">
        <div class="section-header">
          <h2>Profile</h2>
        </div>

        <form class="profile-fields" onSubmit={handleSubmit}>
          <div class="field">
            <label>Username</label>
            <input type="text" name="username" class="setting-input" value={profile().username} />
          </div>

          <div class="field">
            <label>Display Name</label>
            <input type="text" name="name" class="setting-input" value={profile().name ?? ""} />
          </div>

          <div class="field">
            <label>Bio</label>
            <textarea
              name="bio"
              class="setting-input setting-textarea"
              maxlength={2000}
              value={profile().bio ?? ""}
              onInput={(e) => setBioLength(e.currentTarget.value.length)}
            />
            <div class="field-hint" style={{ "text-align": "right" }}>
              {bioLength()}/2000
            </div>
          </div>

          <div class="field">
            <label>Avatar URL</label>
            <input
              type="text"
              name="avatar_url"
              class="setting-input"
              value={profile().avatar_url ?? ""}
            />
          </div>

          <div class="field">
            <label>Role</label>
            <div class="field-value">
              <span class={`badge badge-${profile().role}`}>{profile().role}</span>
            </div>
          </div>

          <div class="field">
            <label>Verified</label>
            <div class="field-value">
              <Show
                when={profile().is_verified}
                fallback={<span class="badge badge-unverified">Unverified</span>}
              >
                <span class="badge badge-verified">
                  <i class="codicon codicon-verified-filled" /> Verified
                </span>
              </Show>
            </div>
          </div>

          <div class="field">
            <label>Member Since</label>
            <div class="field-value">{formatDate(profile().created_at)}</div>
          </div>

          <Show when={saveError()}>
            {(message) => (
              <div class="section-error" style={{ "margin-bottom": "8px" }}>
                <i class="codicon codicon-error" />
                <span>{message()}</span>
              </div>
            )}
          </Show>
          <div style={{ "margin-top": "12px" }}>
            <button type="submit" class="button button-primary" disabled={saving()}>
              {saving() ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </SectionBoundary>
  );
};
