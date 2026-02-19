import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "fibrae";
import type { UserProfile } from "../../types";
import { apiRequest } from "../api";

const profileAtom = Atom.make<UserProfile | null>(null);
const errorAtom = Atom.make<string | null>(null);
const loadingAtom = Atom.make(true);

const editNameAtom = Atom.make("");
const editBioAtom = Atom.make("");
const editAvatarUrlAtom = Atom.make("");
const savingAtom = Atom.make(false);
const saveErrorAtom = Atom.make<string | null>(null);

function loadProfile(registry: AtomRegistry.Registry) {
  registry.set(loadingAtom, true);
  registry.set(errorAtom, null);
  apiRequest<{ user: UserProfile }>("/api/me")
    .then((data) => {
      registry.set(profileAtom, data.user);
      registry.set(editNameAtom, data.user.name ?? "");
      registry.set(editBioAtom, data.user.bio ?? "");
      registry.set(editAvatarUrlAtom, data.user.avatar_url ?? "");
    })
    .catch((err: unknown) => {
      registry.set(errorAtom, err instanceof Error ? err.message : String(err));
    })
    .finally(() => {
      registry.set(loadingAtom, false);
    });
}

let initialized = false;

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export const ProfileSection = () =>
  Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry;

    if (!initialized) {
      initialized = true;
      loadProfile(registry);
    }

    const loading = yield* Atom.get(loadingAtom);
    const error = yield* Atom.get(errorAtom);
    const profile = yield* Atom.get(profileAtom);
    const editName = yield* Atom.get(editNameAtom);
    const editBio = yield* Atom.get(editBioAtom);
    const editAvatarUrl = yield* Atom.get(editAvatarUrlAtom);
    const saving = yield* Atom.get(savingAtom);
    const saveError = yield* Atom.get(saveErrorAtom);

    function saveProfile() {
      registry.set(savingAtom, true);
      registry.set(saveErrorAtom, null);
      void apiRequest("/api/me", "PATCH", {
        name: registry.get(editNameAtom),
        bio: registry.get(editBioAtom),
        avatar_url: registry.get(editAvatarUrlAtom),
      })
        .then(() => {
          loadProfile(registry);
        })
        .catch((err: unknown) => {
          registry.set(saveErrorAtom, err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          registry.set(savingAtom, false);
        });
    }

    if (loading) {
      return <div class="section-loading">Loading profile...</div>;
    }

    if (error) {
      return (
        <div class="section-error">
          <i class="codicon codicon-error" />
          <span>{error}</span>
          <button class="button" onClick={() => loadProfile(registry)}>
            Retry
          </button>
        </div>
      );
    }

    const p = profile;
    if (!p) return <></>;

    return (
      <div class="profile-section">
        <div class="section-header">
          <h2>Profile</h2>
        </div>

        <div class="profile-fields">
          <div class="field">
            <label>
              <i class="codicon codicon-lock" style={{ marginRight: "4px" }} />
              Username
            </label>
            <div class="field-value field-readonly">
              <i class="codicon codicon-account" />
              <span>{p.username}</span>
            </div>
          </div>

          <div class="field">
            <label>Display Name</label>
            <input
              type="text"
              class="setting-input"
              value={editName}
              onInput={(e: Event) => {
                registry.set(editNameAtom, (e.target as HTMLInputElement).value);
              }}
            />
          </div>

          <div class="field">
            <label>Bio</label>
            <textarea
              class="setting-input setting-textarea"
              maxLength={500}
              value={editBio}
              onInput={(e: Event) => {
                registry.set(editBioAtom, (e.target as HTMLTextAreaElement).value);
              }}
            />
            <div class="field-hint" style={{ textAlign: "right" }}>
              {editBio.length}/500
            </div>
          </div>

          <div class="field">
            <label>Avatar URL</label>
            <input
              type="text"
              class="setting-input"
              value={editAvatarUrl}
              onInput={(e: Event) => {
                registry.set(editAvatarUrlAtom, (e.target as HTMLInputElement).value);
              }}
            />
            <div class="field-hint">Syncs from GitHub on login</div>
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

          {saveError && (
            <div class="section-error" style={{ marginBottom: "8px" }}>
              <i class="codicon codicon-error" />
              <span>{saveError}</span>
            </div>
          )}
          <div style={{ marginTop: "12px" }}>
            <button class="button button-primary" onClick={saveProfile} disabled={saving}>
              {saving ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </div>
      </div>
    );
  });
