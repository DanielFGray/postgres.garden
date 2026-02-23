import * as Effect from "effect/Effect";
import { Result } from "@effect-atom/atom";
import { Atom, AtomRegistry } from "fibrae";
import type { UserProfile } from "../../types";
import { apiRequest } from "../api";
import { formatDate } from "../format";

const profileAtom = Atom.make(
  apiRequest<{ user: UserProfile | null }>("/api/me", "GET", undefined, {
    action: "account.profile.load",
  }).pipe(
    Effect.flatMap((data) =>
      data.user
        ? Effect.succeed(data.user)
        : Effect.fail(new Error("Unauthorized")),
    ),
  ),
);

const bioLengthAtom = Atom.make(0);
const savingAtom = Atom.make(false);
const saveErrorAtom = Atom.make<string | null>(null);

export const ProfileSection = () =>
  Effect.gen(function*() {
    const registry = yield* AtomRegistry.AtomRegistry;
    const result = yield* Atom.get(profileAtom);
    const bioLength = yield* Atom.get(bioLengthAtom);
    const saving = yield* Atom.get(savingAtom);
    const saveError = yield* Atom.get(saveErrorAtom);

    function handleSubmit(e: Event) {
      e.preventDefault();
      const form = e.target as HTMLFormElement;
      const data = new FormData(form);
      registry.set(savingAtom, true);
      registry.set(saveErrorAtom, null);
      void Effect.runFork(
        apiRequest(
          "/api/me",
          "PATCH",
          {
            username: data.get("username"),
            name: data.get("name"),
            bio: data.get("bio"),
            avatar_url: data.get("avatar_url"),
          },
          { action: "account.profile.save" },
        ).pipe(
          Effect.tap(() => Effect.sync(() => registry.refresh(profileAtom))),
          Effect.catchAll((err) =>
            Effect.sync(() => {
              registry.set(saveErrorAtom, err.message);
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              registry.set(savingAtom, false);
            }),
          ),
        ),
      );
    }

    return Result.builder(result)
      .onInitial(() => <div class="section-loading">Loading profile...</div>)
      .onError((error) => (
        <div class="section-error">
          <i class="codicon codicon-error" />
          <span>{error.message}</span>
          <button class="button" onClick={() => registry.refresh(profileAtom)}>
            Retry
          </button>
        </div>
      ))
      .onSuccess((p) => (
        <div class="profile-section">
          <div class="section-header">
            <h2>Profile</h2>
          </div>

          <form class="profile-fields" onSubmit={handleSubmit}>
            <div class="field">
              <label>Username</label>
              <input type="text" name="username" class="setting-input" defaultValue={p.username} />
            </div>

            <div class="field">
              <label>Display Name</label>
              <input type="text" name="name" class="setting-input" defaultValue={p.name ?? ""} />
            </div>

            <div class="field">
              <label>Bio</label>
              <textarea
                name="bio"
                class="setting-input setting-textarea"
                maxLength={2000}
                defaultValue={p.bio ?? ""}
                onInput={(e: Event) => {
                  registry.set(bioLengthAtom, (e.target as HTMLTextAreaElement).value.length);
                }}
              />
              <div class="field-hint" style={{ textAlign: "right" }}>
                {bioLength}/2000
              </div>
            </div>

            <div class="field">
              <label>Avatar URL</label>
              <input type="text" name="avatar_url" class="setting-input" defaultValue={p.avatar_url ?? ""} />
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
              <button type="submit" class="button button-primary" disabled={saving}>
                {saving ? "Saving..." : "Save Changes"}
              </button>
            </div>
          </form>
        </div>
      ))
      .render();
  });
