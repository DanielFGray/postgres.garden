import * as Effect from "effect/Effect";
import { Result } from "@effect-atom/atom";
import { Atom, AtomRegistry } from "fibrae";
import { apiRequest } from "../api";

type UserEmail = {
  id: string;
  email: string;
  is_verified: boolean;
  is_primary: boolean;
  created_at: string;
};

const emailsAtom = Atom.make(
  apiRequest<UserEmail[]>("/api/me/emails", "GET", undefined, {
    action: "account.emails.load",
  }),
);

const addingEmailAtom = Atom.make(false);
const actionLoadingAtom = Atom.make<string | null>(null);
const mutationErrorAtom = Atom.make<string | null>(null);

export const EmailsSection = () =>
  Effect.gen(function*() {
    const registry = yield* AtomRegistry.AtomRegistry;
    const result = yield* Atom.get(emailsAtom);
    const addingEmail = yield* Atom.get(addingEmailAtom);
    const actionLoading = yield* Atom.get(actionLoadingAtom);
    const mutationError = yield* Atom.get(mutationErrorAtom);

    function handleMakePrimary(emailId: string) {
      registry.set(actionLoadingAtom, emailId);
      registry.set(mutationErrorAtom, null);
      void Effect.runFork(
        apiRequest("/api/makeEmailPrimary", "POST", { emailId }, {
          action: "account.emails.make_primary",
        }).pipe(
          Effect.tap(() => Effect.sync(() => registry.refresh(emailsAtom))),
          Effect.catchAll((err) =>
            Effect.sync(() => {
              registry.set(mutationErrorAtom, err.message);
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              registry.set(actionLoadingAtom, null);
            }),
          ),
        ),
      );
    }

    function handleResendVerification(emailId: string) {
      registry.set(actionLoadingAtom, emailId);
      registry.set(mutationErrorAtom, null);
      void Effect.runFork(
        apiRequest("/api/resendEmailVerificationCode", "POST", { emailId }, {
          action: "account.emails.resend_verification",
        }).pipe(
          Effect.catchAll((err) =>
            Effect.sync(() => {
              registry.set(mutationErrorAtom, err.message);
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              registry.set(actionLoadingAtom, null);
            }),
          ),
        ),
      );
    }

    function handleRemove(emailId: string) {
      registry.set(actionLoadingAtom, emailId);
      registry.set(mutationErrorAtom, null);
      void Effect.runFork(
        apiRequest("/api/me/emails/" + emailId, "DELETE", undefined, {
          action: "account.emails.remove",
        }).pipe(
          Effect.tap(() => Effect.sync(() => registry.refresh(emailsAtom))),
          Effect.catchAll((err) =>
            Effect.sync(() => {
              registry.set(mutationErrorAtom, err.message);
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              registry.set(actionLoadingAtom, null);
            }),
          ),
        ),
      );
    }

    function handleAddEmail(e: Event) {
      e.preventDefault();
      const form = e.target as HTMLFormElement;
      const data = new FormData(form);
      const emailValue = (data.get("email") as string | null)?.trim();
      if (!emailValue) return;

      registry.set(addingEmailAtom, true);
      registry.set(mutationErrorAtom, null);
      void Effect.runFork(
        apiRequest("/api/me/emails", "POST", { email: emailValue }, {
          action: "account.emails.add",
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              form.reset();
              registry.refresh(emailsAtom);
            }),
          ),
          Effect.catchAll((err) =>
            Effect.sync(() => {
              registry.set(mutationErrorAtom, err.message);
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              registry.set(addingEmailAtom, false);
            }),
          ),
        ),
      );
    }

    return Result.builder(result)
      .onInitial(() => <div class="section-loading">Loading emails...</div>)
      .onError((error) => (
        <div class="section-error">
          <i class="codicon codicon-error" />
          <span>{error.message}</span>
          <button class="button" onClick={() => registry.refresh(emailsAtom)}>
            Retry
          </button>
        </div>
      ))
      .onSuccess((emails) => (
        <div class="emails-section">
          <div class="section-header">
            <h2>Email Addresses</h2>
          </div>

          {mutationError && (
            <div class="section-error" style={{ marginBottom: "12px" }}>
              <i class="codicon codicon-error" />
              <span>{mutationError}</span>
            </div>
          )}

          <div class="email-list">
            {emails.map((email) => (
              <div class="field" key={email.id}>
                <div class="field-value email-row">
                  <span class="email-address">{email.email}</span>
                  <span class="email-badges">
                    {email.is_primary && <span class="badge badge-primary">Primary</span>}
                    {email.is_verified ? (
                      <span class="badge badge-verified">
                        <i class="codicon codicon-verified-filled" /> Verified
                      </span>
                    ) : (
                      <span class="badge badge-unverified">Unverified</span>
                    )}
                  </span>
                  <span class="email-actions">
                    {email.is_verified && !email.is_primary && (
                      <button
                        class="button"
                        disabled={actionLoading === email.id}
                        onClick={() => handleMakePrimary(email.id)}
                      >
                        Make Primary
                      </button>
                    )}
                    {!email.is_verified && (
                      <button
                        class="button"
                        disabled={actionLoading === email.id}
                        onClick={() => handleResendVerification(email.id)}
                      >
                        Resend Verification
                      </button>
                    )}
                    {!email.is_primary && (
                      <button
                        class="button"
                        disabled={actionLoading === email.id}
                        onClick={() => handleRemove(email.id)}
                      >
                        Remove
                      </button>
                    )}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <form class="add-email-form" onSubmit={handleAddEmail}>
            <div class="field">
              <label>Add Email Address</label>
              <div class="add-email-row">
                <input
                  type="email"
                  name="email"
                  class="email-input"
                  placeholder="email@example.com"
                  disabled={addingEmail}
                />
                <button type="submit" class="button" disabled={addingEmail}>
                  Add
                </button>
              </div>
            </div>
          </form>
        </div>
      ))
      .render();
  });
