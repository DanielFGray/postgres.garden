import { createSignal, refresh, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type * as Effect from "effect/Effect";
import type { ApiRequestError } from "../../../../httpapi-client";
import { apiCall } from "../api";
import { formText } from "../format";
import { createRequest, runRequest } from "../../../webview/request";
import { SectionBoundary } from "../SectionBoundary";

const loadEmails = () => apiCall("account.emails.load", (api) => api.apiUsers.meEmails({}));

const testId = (email: string) =>
  `email-settings-item-${email
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()}`;

export const EmailsSection = () => {
  const emails = createRequest(loadEmails);
  const [addingEmail, setAddingEmail] = createSignal(false);
  const [actionLoading, setActionLoading] = createSignal<string | null>(null);
  const [mutationError, setMutationError] = createSignal<string | null>(null);

  const runAction = <A,>(
    emailId: string,
    request: Effect.Effect<A, ApiRequestError>,
    refreshAfter = false,
  ) => {
    setActionLoading(emailId);
    setMutationError(null);
    void runRequest(request)
      .then(
        () => {
          if (refreshAfter) void refresh(emails);
        },
        (error: Error) => setMutationError(error.message),
      )
      .finally(() => setActionLoading(null));
  };

  function handleMakePrimary(emailId: string) {
    runAction(
      emailId,
      apiCall("account.emails.make_primary", (api) =>
        api.apiUsers.makeEmailPrimary({ payload: { emailId } }),
      ),
      true,
    );
  }

  function handleResendVerification(emailId: string) {
    runAction(
      emailId,
      apiCall("account.emails.resend_verification", (api) =>
        api.apiUsers.resendEmailVerificationCode({ payload: { emailId } }),
      ),
    );
  }

  function handleRemove(emailId: string) {
    runAction(
      emailId,
      apiCall("account.emails.remove", (api) =>
        api.apiUsers.deleteMeEmail({ params: { id: emailId } }),
      ),
      true,
    );
  }

  const handleAddEmail: JSX.EventHandler<HTMLFormElement, SubmitEvent> = (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const email = formText(new FormData(form), "email").trim();
    if (!email) return;

    setAddingEmail(true);
    setMutationError(null);
    void runRequest(
      apiCall("account.emails.add", (api) => api.apiUsers.createMeEmail({ payload: { email } })),
    )
      .then(
        () => {
          form.reset();
          void refresh(emails);
        },
        (error: Error) => setMutationError(error.message),
      )
      .finally(() => setAddingEmail(false));
  };

  return (
    <SectionBoundary loading="Loading emails..." retry={() => refresh(emails)}>
      <div class="emails-section" data-pw="emails-section">
        <div class="section-header">
          <h2>Email Addresses</h2>
        </div>

        <Show when={mutationError()}>
          {(message) => (
            <div
              class="section-error"
              style={{ "margin-bottom": "12px" }}
              data-pw="email-settings-error"
            >
              <i class="codicon codicon-error" />
              <span>{message()}</span>
            </div>
          )}
        </Show>

        <div class="email-list" data-pw="email-settings-list">
          <For each={emails()}>
            {(email) => (
              <div class="field" data-pw={testId(email.email)}>
                <div class="field-value email-row">
                  <span class="email-address">{email.email}</span>
                  <span class="email-badges">
                    <Show when={email.is_primary}>
                      <span class="badge badge-primary" data-pw="email-settings-indicator-primary">
                        Primary
                      </span>
                    </Show>
                    <Show
                      when={email.is_verified}
                      fallback={
                        <span
                          class="badge badge-unverified"
                          data-pw="email-settings-indicator-unverified"
                        >
                          Unverified
                        </span>
                      }
                    >
                      <span class="badge badge-verified">
                        <i class="codicon codicon-verified-filled" /> Verified
                      </span>
                    </Show>
                  </span>
                  <span class="email-actions">
                    <Show when={email.is_verified && !email.is_primary}>
                      <button
                        class="button"
                        disabled={actionLoading() === email.id}
                        onClick={() => handleMakePrimary(email.id)}
                        data-pw="email-settings-button-makeprimary"
                      >
                        Make Primary
                      </button>
                    </Show>
                    <Show when={!email.is_verified}>
                      <button
                        class="button"
                        disabled={actionLoading() === email.id}
                        onClick={() => handleResendVerification(email.id)}
                        data-pw="email-settings-button-resendverification"
                      >
                        Resend Verification
                      </button>
                    </Show>
                    <Show when={!email.is_primary}>
                      <button
                        class="button"
                        disabled={actionLoading() === email.id}
                        onClick={() => handleRemove(email.id)}
                        data-pw="email-settings-button-delete"
                      >
                        Remove
                      </button>
                    </Show>
                  </span>
                </div>
              </div>
            )}
          </For>
        </div>

        <form class="add-email-form" onSubmit={handleAddEmail} data-pw="settings-email-form">
          <div class="field">
            <label>Add Email Address</label>
            <div class="add-email-row">
              <input
                type="email"
                name="email"
                class="email-input"
                placeholder="email@example.com"
                disabled={addingEmail()}
                data-pw="settings-email-input"
              />
              <button
                type="submit"
                class="button"
                disabled={addingEmail()}
                data-pw="settings-email-submit"
              >
                Add
              </button>
            </div>
          </div>
        </form>
      </div>
    </SectionBoundary>
  );
};
