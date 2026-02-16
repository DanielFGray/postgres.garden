import { signal, effect } from "@preact/signals";
import type { UserProfile } from "../../types";
import { apiRequest } from "../api";

const profile = signal<UserProfile | null>(null);
const error = signal<string | null>(null);
const loading = signal(true);

function loadProfile() {
  loading.value = true;
  error.value = null;
  apiRequest<UserProfile>("/api/me")
    .then((data) => {
      profile.value = data;
    })
    .catch((err: unknown) => {
      error.value = err instanceof Error ? err.message : String(err);
    })
    .finally(() => {
      loading.value = false;
    });
}

effect(() => {
  loadProfile();
});

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function ProfileSection() {
  if (loading.value) {
    return <div class="section-loading">Loading profile...</div>;
  }

  if (error.value) {
    return (
      <div class="section-error">
        <i class="codicon codicon-error" />
        <span>{error.value}</span>
        <button class="button" onClick={loadProfile}>Retry</button>
      </div>
    );
  }

  const p = profile.value;
  if (!p) return null;

  return (
    <div class="profile-section">
      <div class="section-header">
        <h2>Profile</h2>
      </div>

      <div class="profile-fields">
        <div class="field">
          <label>Username</label>
          <div class="field-value field-readonly">
            <i class="codicon codicon-account" />
            <span>{p.username}</span>
          </div>
        </div>

        <div class="field">
          <label>Display Name</label>
          <div class="field-value">
            {p.name ?? <span class="field-empty">Not set</span>}
          </div>
        </div>

        <div class="field">
          <label>Bio</label>
          <div class="field-value">
            {p.bio || <span class="field-empty">No bio</span>}
          </div>
        </div>

        <div class="field">
          <label>Avatar URL</label>
          <div class="field-value">
            {p.avatar_url ? (
              <div class="avatar-preview">
                <img src={p.avatar_url} alt="Avatar" class="avatar-img" />
                <span class="avatar-url">{p.avatar_url}</span>
              </div>
            ) : (
              <span class="field-empty">Not set</span>
            )}
          </div>
        </div>

        <div class="field">
          <label>Role</label>
          <div class="field-value">
            <span class={`badge badge-${p.role}`}>{p.role}</span>
          </div>
        </div>

        <div class="field">
          <label>Verified</label>
          <div class="field-value">
            {p.is_verified ? (
              <span class="badge badge-verified">
                <i class="codicon codicon-verified-filled" /> Verified
              </span>
            ) : (
              <span class="badge badge-unverified">Unverified</span>
            )}
          </div>
        </div>

        <div class="field">
          <label>Member Since</label>
          <div class="field-value">{formatDate(String(p.created_at))}</div>
        </div>
      </div>
    </div>
  );
}
