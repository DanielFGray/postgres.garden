import { createSignal, refresh, Show } from "solid-js";
import * as Effect from "effect/Effect";
import type { UserProfile } from "../../types";
import { createRequest, runRequest } from "../../../webview/request";
import { SectionBoundary } from "../SectionBoundary";
import { apiRequest } from "../api";
import { formatDate } from "../format";
import { WebviewRequestError } from "../../../webview/apiBridge";

const loadProfile = () =>
  apiRequest<{ user: UserProfile | null }>("/api/me", "GET", undefined, {
    action: "account.profile.load",
  }).pipe(
    Effect.flatMap((data) =>
      data.user
        ? Effect.succeed(data.user)
        : Effect.fail(new WebviewRequestError({ message: "Unauthorized", code: "UNAUTHORIZED" })),
    ),
  );

export const ProfileSection = () => {
  const profile = createRequest(loadProfile);
  const [bioLength, setBioLength] = createSignal(0);
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);

  function handleSubmit(e: Event) {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const data = new FormData(form);
    const getText = (name: string) => {
      const value = data.get(name);
      return value instanceof File ? "" : (value ?? "");
    };
    setSaving(true);
    setSaveError(null);
    void runRequest(
      apiRequest(
        "/api/me",
        "PATCH",
        {
          username: getText("username"),
          name: getText("name"),
          bio: getText("bio"),
          avatar_url: getText("avatar_url"),
        },
        { action: "account.profile.save" },
      ),
    )
      .then(
        () => refresh(profile),
        (error: Error) => setSaveError(error.message),
      )
      .finally(() => setSaving(false));
  }

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
            <div class="field-value">{formatDate(String(profile().created_at))}</div>
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
