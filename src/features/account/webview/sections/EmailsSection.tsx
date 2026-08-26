import { createSignal, refresh, For, Show } from "solid-js";
import { apiRequest } from "../api";
import { createRequest, runRequest } from "../../../webview/request";
import { SectionBoundary } from "../SectionBoundary";

type UserEmail = {
  id: string;
  email: string;
  is_verified: boolean;
  is_primary: boolean;
  created_at: string;
};

const loadEmails = () =>
  apiRequest<UserEmail[]>("/api/me/emails", "GET", undefined, {
    action: "account.emails.load",
  });

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

  const runAction = (
    emailId: string,
    request: ReturnType<typeof apiRequest>,
    refreshAfter = false,
  ) => {
    setActionLoading(emailId);
    setMutationError(null);
    void runRequest(request)
      .then(
        () => refreshAfter && refresh(emails),
        (error: Error) => setMutationError(error.message),
      )
      .finally(() => setActionLoading(null));
  };

  function handleMakePrimary(emailId: string) {
    runAction(
      emailId,
      apiRequest(
        "/api/makeEmailPrimary",
        "POST",
        { emailId },
        { action: "account.emails.make_primary" },
      ),
      true,
    );
  }

  function handleResendVerification(emailId: string) {
    runAction(
      emailId,
      apiRequest(
        "/api/resendEmailVerificationCode",
        "POST",
        { emailId },
        { action: "account.emails.resend_verification" },
      ),
    );
  }

  function handleRemove(emailId: string) {
    runAction(
      emailId,
      apiRequest("/api/me/emails/" + emailId, "DELETE", undefined, {
        action: "account.emails.remove",
      }),
      true,
    );
  }

  function handleAddEmail(e: Event) {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const data = new FormData(form);
    const emailValue = (data.get("email") as string | null)?.trim();
    if (!emailValue) return;

    setAddingEmail(true);
    setMutationError(null);
    void runRequest(
      apiRequest("/api/me/emails", "POST", { email: emailValue }, { action: "account.emails.add" }),
    )
      .then(
        () => {
          form.reset();
          refresh(emails);
        },
        (error: Error) => setMutationError(error.message),
      )
      .finally(() => setAddingEmail(false));
  }

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
