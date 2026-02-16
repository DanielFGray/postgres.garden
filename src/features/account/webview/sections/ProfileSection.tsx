import { signal, effect } from "@preact/signals";
import { Effect } from "effect";
import type { ApiError } from "../api";
import { apiRequest, formatApiError } from "../api";
import { AccountMeResponseSchema, type AccountUser } from "../models";

const profile = signal<AccountUser | null>(null);
const error = signal<string | null>(null);
const loading = signal(true);

function loadProfile() {
  loading.value = true;
  error.value = null;
  void Effect.runPromise(apiRequest("/api/me", AccountMeResponseSchema))
    .then((data) => {
      if (!data.user) {
        profile.value = null;
        error.value = "No active session";
        return;
      }
      profile.value = data.user;
    })
    .catch((err: unknown) => {
      if (err && typeof err === "object" && "_tag" in err) {
        error.value = formatApiError(err as ApiError);
      } else {
        error.value = err instanceof Error ? err.message : String(err);
      }
    })
    .finally(() => {
      loading.value = false;
    });
}

effect(() => {
  loadProfile();
});

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
          <label>Account ID</label>
          <div class="field-value">
            <span class="field-mono">{p.id}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
