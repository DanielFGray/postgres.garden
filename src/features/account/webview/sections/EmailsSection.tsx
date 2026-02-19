import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "fibrae";
import { apiRequest } from "../api";

type UserEmail = {
  id: string;
  email: string;
  is_verified: boolean;
  is_primary: boolean;
  created_at: string;
};

const emailsAtom = Atom.make<UserEmail[]>([]);
const loadingAtom = Atom.make(true);
const errorAtom = Atom.make<string | null>(null);
const newEmailAtom = Atom.make("");
const addingEmailAtom = Atom.make(false);
const actionLoadingAtom = Atom.make<string | null>(null);

function loadEmails(registry: AtomRegistry.Registry) {
  registry.set(loadingAtom, true);
  registry.set(errorAtom, null);
  apiRequest<UserEmail[]>("/api/me/emails")
    .then((data) => {
      registry.set(emailsAtom, data);
    })
    .catch((err: unknown) => {
      registry.set(errorAtom, err instanceof Error ? err.message : String(err));
    })
    .finally(() => {
      registry.set(loadingAtom, false);
    });
}

let initialized = false;

export const EmailsSection = () =>
  Effect.gen(function* () {
    const registry = yield* AtomRegistry.AtomRegistry;

    if (!initialized) {
      initialized = true;
      loadEmails(registry);
    }

    const emails = yield* Atom.get(emailsAtom);
    const loading = yield* Atom.get(loadingAtom);
    const error = yield* Atom.get(errorAtom);
    const newEmail = yield* Atom.get(newEmailAtom);
    const addingEmail = yield* Atom.get(addingEmailAtom);
    const actionLoading = yield* Atom.get(actionLoadingAtom);

    function handleMakePrimary(emailId: string) {
      registry.set(actionLoadingAtom, emailId);
      apiRequest("/api/makeEmailPrimary", "POST", { emailId })
        .then(() => {
          loadEmails(registry);
        })
        .catch((err: unknown) => {
          registry.set(errorAtom, err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          registry.set(actionLoadingAtom, null);
        });
    }

    function handleResendVerification(emailId: string) {
      registry.set(actionLoadingAtom, emailId);
      apiRequest("/api/resendEmailVerificationCode", "POST", { emailId })
        .then(() => {
          registry.set(actionLoadingAtom, null);
        })
        .catch((err: unknown) => {
          registry.set(errorAtom, err instanceof Error ? err.message : String(err));
          registry.set(actionLoadingAtom, null);
        });
    }

    function handleRemove(emailId: string) {
      registry.set(actionLoadingAtom, emailId);
      apiRequest("/api/me/emails/" + emailId, "DELETE")
        .then(() => {
          loadEmails(registry);
        })
        .catch((err: unknown) => {
          registry.set(errorAtom, err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          registry.set(actionLoadingAtom, null);
        });
    }

    function handleAddEmail(e: Event) {
      e.preventDefault();
      const emailValue = registry.get(newEmailAtom).trim();
      if (!emailValue) return;

      registry.set(addingEmailAtom, true);
      registry.set(errorAtom, null);
      apiRequest("/api/me/emails", "POST", { email: emailValue })
        .then(() => {
          registry.set(newEmailAtom, "");
          loadEmails(registry);
        })
        .catch((err: unknown) => {
          registry.set(errorAtom, err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          registry.set(addingEmailAtom, false);
        });
    }

    if (loading) {
      return <div class="section-loading">Loading emails...</div>;
    }

    if (error && emails.length === 0) {
      return (
        <div class="section-error">
          <i class="codicon codicon-error" />
          <span>{error}</span>
          <button class="button" onClick={() => loadEmails(registry)}>Retry</button>
        </div>
      );
    }

    return (
      <div class="emails-section">
        <div class="section-header">
          <h2>Email Addresses</h2>
        </div>

        {error && (
          <div class="section-error" style={{ marginBottom: "12px" }}>
            <i class="codicon codicon-error" />
            <span>{error}</span>
          </div>
        )}

        <div class="email-list">
          {emails.map((email) => (
            <div class="field" key={email.id}>
              <div class="field-value email-row">
                <span class="email-address">{email.email}</span>
                <span class="email-badges">
                  {email.is_primary && (
                    <span class="badge badge-primary">Primary</span>
                  )}
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
                class="email-input"
                placeholder="email@example.com"
                value={newEmail}
                onInput={(e: Event) => {
                  registry.set(newEmailAtom, (e.target as HTMLInputElement).value);
                }}
                disabled={addingEmail}
              />
              <button
                type="submit"
                class="button"
                disabled={addingEmail || !newEmail.trim()}
              >
                Add
              </button>
            </div>
          </div>
        </form>
      </div>
    );
  });
